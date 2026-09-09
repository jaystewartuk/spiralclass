import { logger } from "@/lib/logger";
import { presignS3Url } from "@/lib/aws/sigv4";
import { r2PublicUrl } from "@/lib/storage/r2-public-url";

const log = logger({ surface: "storage" });

// Storage provider abstraction — the single seam between the app and whatever
// object store backs it. Every object-storage operation in the codebase
// (teacher photos + class/library materials) goes through a `StorageProvider`,
// and `getStorageProvider()` below is the ONE place that names a concrete
// backend (Cloudflare R2). Swapping in another backend is a new implementation
// file plus a one-line change there — no caller imports a storage SDK or
// hard-codes a vendor URL.
//
// The contract is deliberately the lowest common denominator of "an S3-shaped
// bucket": put an object, delete objects, mint a short-lived signed URL for a
// private object, build a stable public URL, and (best-effort) provision a
// bucket. R2 (via the S3 API) satisfies it. (Supabase Storage did too, before
// the D-89 decommission removed that provider.)

export type StorageBody = Blob | File | ArrayBuffer | Uint8Array;

export type UploadOptions = {
  contentType?: string;
  // When true an existing object at the same key is replaced; when false a
  // collision is an error (callers that key by timestamp rely on this).
  upsert?: boolean;
  // Optional Cache-Control response header, stored on the object. Left unset
  // by default (R2's own default applies) — only pass this for objects whose
  // public URL changes whenever the content does (e.g. a `?v=` cache-buster
  // query param), so a long max-age can never serve stale content. See
  // PUBLIC_VERSIONED_ASSET_CACHE_CONTROL below.
  cacheControl?: string;
};

// A year, immutable: safe only for objects served through a URL that changes
// on every re-upload (teacher-photo.ts / teacher-video.ts's `?v=` cache-buster
// param) — the browser/CDN cache key changes along with the content, so a
// long max-age can never go stale. Do NOT apply this to an object whose
// public URL is stable across re-uploads (e.g. testimonial photos have no
// version param today) — that would serve a stale image for up to a year.
export const PUBLIC_VERSIONED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type StorageError = { message: string };
export type StorageResult = { error: StorageError | null };

export type EnsureBucketOptions = {
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
};

export interface StorageProvider {
  upload(
    bucket: string,
    path: string,
    body: StorageBody,
    opts?: UploadOptions,
  ): Promise<StorageResult>;
  remove(bucket: string, paths: string[]): Promise<StorageResult>;
  // Short-lived URL for a private object. Returns null on any failure so
  // callers can fall back (e.g. to an external link) rather than throw.
  createSignedUrl(bucket: string, path: string, ttlSeconds: number): Promise<string | null>;
  // Stable, unauthenticated URL for an object in a public bucket. Pure +
  // credential-free so it is safe to call during render; `version` is appended
  // as a cache-buster. Returns null when the path or backend URL is missing.
  publicUrl(bucket: string, path: string | null | undefined, version?: number): string | null;
  // Idempotently provision a bucket (self-heals preview/dev). "already exists"
  // is the steady state and is swallowed.
  ensureBucket(bucket: string, opts?: EnsureBucketOptions): Promise<void>;
}

// --- Cloudflare R2 implementation -----------------------------------------
//
// R2 is S3-compatible, so this reuses the hand-rolled SigV4 presigner
// (lib/aws/sigv4.ts) already exercised by chat-audio.ts/chat-video.ts and
// lesson-audio-store.ts rather than pulling in @aws-sdk/client-s3. Unlike
// those single-bucket modules, this provider is called with a `bucket`
// argument at each call site (TEACHER_PHOTO_BUCKET / MATERIALS_BUCKET), so
// each logical bucket has its own env-var prefix mapping to its own R2
// bucket + credentials.

// Maps the app's logical bucket name to the FULL env-var prefix carrying its
// R2 config (e.g. "TEACHER_PHOTOS_R2" for TEACHER_PHOTOS_R2_BUCKET/_ENDPOINT/
// _REGION/_ACCESS_KEY/_SECRET). Kept as a full prefix rather than a bare name
// + hardcoded "_R2_" infix because one entry, "recordings", predates a
// consistent naming rule and uses "_S3_" instead (LIVEKIT_EGRESS_S3_* — the
// LiveKit egress bucket's env vars were named for the egress feature, not
// this module). See infra/cloudflare-r2/variables.tf's `env_prefix` field,
// which mirrors this map 1:1 — the two must stay in sync.
const R2_ENV_PREFIX: Record<string, string> = {
  "teacher-photos": "TEACHER_PHOTOS_R2",
  "teacher-videos": "TEACHER_VIDEOS_R2",
  "student-photos": "STUDENT_PHOTOS_R2",
  "class-materials": "CLASS_MATERIALS_R2",
  "chat-audio": "CHAT_AUDIO_R2",
  "material-podcasts": "MATERIAL_PODCASTS_R2",
  recordings: "LIVEKIT_EGRESS_S3",
};

export type R2BucketConfig = {
  bucket: string;
  host: string;
  region: string;
  accessKey: string;
  secret: string;
};

// Exported so every direct-R2 consumer (chat-audio.ts, chat-video.ts,
// recording.ts, lesson-audio-store.ts) reads its config through one place
// instead of each hand-rolling process.env parsing — see R2_ENV_PREFIX above
// for the bucket → env-var-prefix mapping.
export function r2BucketConfig(bucket: string): R2BucketConfig | null {
  const prefix = R2_ENV_PREFIX[bucket];
  if (!prefix) {
    log.warn("r2 provider: unknown bucket", { bucket });
    return null;
  }
  const bucketName = process.env[`${prefix}_BUCKET`]?.trim();
  const endpoint = process.env[`${prefix}_ENDPOINT`]?.trim();
  const region = process.env[`${prefix}_REGION`]?.trim() || "auto";
  const accessKey = process.env[`${prefix}_ACCESS_KEY`]?.trim();
  const secret = process.env[`${prefix}_SECRET`]?.trim();
  if (!bucketName || !endpoint || !accessKey || !secret) {
    log.warn("r2 provider: not configured", { bucket, prefix });
    return null;
  }
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    log.warn("r2 provider: invalid endpoint URL", { bucket, endpoint });
    return null;
  }
  return { bucket: bucketName, host, region, accessKey, secret };
}

// Path-style addressing (bucket as first path segment), matching the other
// R2 consumers in this codebase.
export function r2ObjectPath(cfg: R2BucketConfig, path: string): string {
  return `/${cfg.bucket}/${path}`;
}

export function createR2Provider(): StorageProvider {
  return {
    async upload(bucket, path, body, opts) {
      const cfg = r2BucketConfig(bucket);
      if (!cfg) return { error: { message: "r2-not-configured" } };

      // S3/R2 PUT always overwrites; emulate Supabase's upsert:false
      // (collision is an error) with a cheap existence check first.
      if (!(opts?.upsert ?? false)) {
        const headUrl = presignS3Url({
          accessKeyId: cfg.accessKey,
          secretAccessKey: cfg.secret,
          region: cfg.region,
          host: cfg.host,
          method: "HEAD",
          path: r2ObjectPath(cfg, path),
          expiresInSeconds: 60,
          now: new Date(),
        });
        const headRes = await fetch(headUrl, { method: "HEAD" });
        if (headRes.ok) {
          return { error: { message: "object already exists" } };
        }
      }

      const putUrl = presignS3Url({
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secret,
        region: cfg.region,
        host: cfg.host,
        method: "PUT",
        path: r2ObjectPath(cfg, path),
        expiresInSeconds: 300,
        now: new Date(),
      });
      const putHeaders: Record<string, string> = {};
      if (opts?.contentType) putHeaders["Content-Type"] = opts.contentType;
      if (opts?.cacheControl) putHeaders["Cache-Control"] = opts.cacheControl;

      const res = await fetch(putUrl, {
        method: "PUT",
        headers: Object.keys(putHeaders).length ? putHeaders : undefined,
        body: body as BodyInit,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log.warn("upload failed", { bucket, path, status: res.status, body: text.slice(0, 200) });
        return { error: { message: `r2-put-http-${res.status}` } };
      }
      return { error: null };
    },
    async remove(bucket, paths) {
      const cfg = r2BucketConfig(bucket);
      if (!cfg) return { error: { message: "r2-not-configured" } };

      const errors = await Promise.all(
        paths.map(async (path) => {
          const url = presignS3Url({
            accessKeyId: cfg.accessKey,
            secretAccessKey: cfg.secret,
            region: cfg.region,
            host: cfg.host,
            method: "DELETE",
            path: r2ObjectPath(cfg, path),
            expiresInSeconds: 60,
            now: new Date(),
          });
          const res = await fetch(url, { method: "DELETE" });
          if (!res.ok && res.status !== 404) return `r2-delete-http-${res.status}`;
          return null;
        }),
      );
      const failures = errors.filter((e): e is string => e !== null);
      return { error: failures.length ? { message: failures.join("; ") } : null };
    },
    async createSignedUrl(bucket, path, ttlSeconds) {
      const cfg = r2BucketConfig(bucket);
      if (!cfg) return null;
      return presignS3Url({
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secret,
        region: cfg.region,
        host: cfg.host,
        method: "GET",
        path: r2ObjectPath(cfg, path),
        expiresInSeconds: ttlSeconds,
        now: new Date(),
      });
    },
    publicUrl(bucket, path, version) {
      return r2PublicUrl(bucket, path, version);
    },
    async ensureBucket() {
      // R2 buckets are provisioned out-of-band (Cloudflare dashboard/wrangler)
      // — this minimal SigV4 client doesn't implement CreateBucket. Prod
      // Supabase buckets were already provisioned out-of-band too, so this
      // stays a no-op rather than growing a bespoke bucket-creation call.
    },
  };
}

let provider: StorageProvider | null = null;

// The app-wide storage backend. Everything object-storage goes through the
// instance this returns.
export function getStorageProvider(): StorageProvider {
  return (provider ??= createR2Provider());
}
