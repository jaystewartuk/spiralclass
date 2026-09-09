import "server-only";

import { presignS3Url } from "@/lib/aws/sigv4";
import { logger } from "@/lib/logger";

const log = logger({ surface: "storage-admin" });

// Superadmin R2 object browser — the read-only, allowlisted seam a superadmin
// uses to inspect the app's own storage while debugging support tickets.
//
// This is deliberately NOT "browse every bucket the Cloudflare account holds".
// The account also holds full DB backups, OpenTofu state (plaintext infra
// secrets), and a SEPARATE product's bucket — none of which belong to this app
// or on an app admin surface. The list below is a hand-maintained ALLOWLIST of
// this product's own content buckets only. To add a bucket, it must (a) belong
// to SpiralClass and (b) hold data a superadmin is entitled to inspect. Never
// add `agendaprofe-backups`, `agendaprofe-tofu-state`, or another product's
// bucket here — those live behind the Cloudflare dashboard / infra Access
// policy under separate credentials, not the app's runtime token.
//
// Each entry is gated on its own env-prefixed credentials being present, so the
// browser ships DARK: a bucket only appears once its `{PREFIX}_R2_*` vars are
// set (same discipline as the rest of the R2 seam in lib/storage/provider.ts).

export type BucketSensitivity = "public" | "private" | "sensitive";

export type BrowsableBucket = {
  // Stable id used in the URL / server-action args. Not the real bucket name.
  key: string;
  label: string;
  // Env-var prefix carrying this bucket's R2 config: `{prefix}_R2_BUCKET`,
  // `{prefix}_R2_ENDPOINT`, `{prefix}_R2_REGION`, `{prefix}_R2_ACCESS_KEY`,
  // `{prefix}_R2_SECRET`.
  envPrefix: string;
  sensitivity: BucketSensitivity;
  description: string;
};

// The allowlist. Only this app's own content buckets that have server-side
// credentials wired into the codebase today.
const BROWSABLE_BUCKETS: BrowsableBucket[] = [
  {
    key: "class-materials",
    label: "Class materials",
    envPrefix: "CLASS_MATERIALS",
    sensitivity: "private",
    description: "Per-booking attachments and reusable library materials, keyed {teacherId}/…",
  },
  {
    key: "teacher-photos",
    label: "Teacher photos",
    envPrefix: "TEACHER_PHOTOS",
    sensitivity: "public",
    description: "Teacher profile photos and testimonial author avatars (public bucket).",
  },
  {
    key: "chat-audio",
    label: "Chat audio / video",
    envPrefix: "CHAT_AUDIO",
    sensitivity: "sensitive",
    description: "Voice and video messages exchanged in in-app chat.",
  },
];

export type R2AdminConfig = {
  bucket: string;
  host: string;
  region: string;
  accessKey: string;
  secret: string;
};

// Resolve the R2 credentials for an allowlisted bucket. Returns null when the
// bucket isn't in the allowlist or its env config is incomplete — callers
// treat both as "not available" so the browser degrades rather than throws.
function resolveConfig(entry: BrowsableBucket): R2AdminConfig | null {
  const p = entry.envPrefix;
  const bucket = process.env[`${p}_R2_BUCKET`]?.trim();
  const endpoint = process.env[`${p}_R2_ENDPOINT`]?.trim();
  const region = process.env[`${p}_R2_REGION`]?.trim() || "auto";
  const accessKey = process.env[`${p}_R2_ACCESS_KEY`]?.trim();
  const secret = process.env[`${p}_R2_SECRET`]?.trim();
  if (!bucket || !endpoint || !accessKey || !secret) return null;
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    log.warn("invalid endpoint URL", { bucket: entry.key });
    return null;
  }
  return { bucket, host, region, accessKey, secret };
}

function findEntry(bucketKey: string): BrowsableBucket | null {
  return BROWSABLE_BUCKETS.find((b) => b.key === bucketKey) ?? null;
}

// Metadata for a browsable bucket without exposing credentials — safe to hand
// to the client (page/component).
export type BrowsableBucketInfo = Omit<BrowsableBucket, "envPrefix">;

// The allowlisted buckets that are actually configured in this environment.
// Dark-safe: an entry with no credentials is silently omitted.
export function listBrowsableBuckets(): BrowsableBucketInfo[] {
  return BROWSABLE_BUCKETS.filter((b) => resolveConfig(b) !== null).map((b) => ({
    key: b.key,
    label: b.label,
    sensitivity: b.sensitivity,
    description: b.description,
  }));
}

// --- ListObjectsV2 -------------------------------------------------------

export type StorageObject = { key: string; size: number; lastModified: string };

export type Listing = {
  // "Folders" — common prefixes below the current prefix (delimiter = "/").
  prefixes: string[];
  objects: StorageObject[];
  // Opaque cursor for the next page, or null when the listing is complete.
  nextToken: string | null;
};

// Decode the small set of XML entities S3 escapes in element text.
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}

function allBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// Parse an S3 ListObjectsV2 XML body. Exported for unit testing against a
// fixture — the response shape is stable and controlled, so a targeted regex
// parse is preferred over adding an XML-parser dependency (matches the
// no-AWS-SDK stance of lib/aws/sigv4.ts).
export function parseListResult(xml: string): Listing {
  const prefixes = allBlocks(xml, "CommonPrefixes")
    .map((block) => firstTag(block, "Prefix"))
    .filter((p): p is string => p != null);

  const objects: StorageObject[] = allBlocks(xml, "Contents").map((block) => ({
    key: firstTag(block, "Key") ?? "",
    size: Number(firstTag(block, "Size") ?? "0"),
    lastModified: firstTag(block, "LastModified") ?? "",
  }));

  const truncated = firstTag(xml, "IsTruncated") === "true";
  const nextToken = truncated ? firstTag(xml, "NextContinuationToken") : null;

  return { prefixes, objects, nextToken: nextToken ?? null };
}

export class BucketUnavailableError extends Error {
  constructor(bucketKey: string) {
    super(`bucket "${bucketKey}" is not a configured, browsable bucket`);
    this.name = "BucketUnavailableError";
  }
}

const PAGE_SIZE = 100;

// List one page of a bucket at `prefix`, folder-style (delimiter "/"). Throws
// BucketUnavailableError for an unknown/unconfigured bucket so the caller can
// return a clean error instead of leaking config state.
export async function listObjects(
  bucketKey: string,
  prefix: string,
  continuationToken?: string,
): Promise<Listing> {
  const entry = findEntry(bucketKey);
  const cfg = entry && resolveConfig(entry);
  if (!entry || !cfg) throw new BucketUnavailableError(bucketKey);

  const query: Record<string, string> = {
    "list-type": "2",
    delimiter: "/",
    "max-keys": String(PAGE_SIZE),
  };
  if (prefix) query.prefix = prefix;
  if (continuationToken) query["continuation-token"] = continuationToken;

  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "GET",
    path: `/${cfg.bucket}`,
    expiresInSeconds: 60,
    now: new Date(),
    query,
  });

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn("list failed", { bucket: bucketKey, status: res.status, body: body.slice(0, 200) });
    throw new Error(`r2-list-http-${res.status}`);
  }
  return parseListResult(await res.text());
}

// Mint a short-lived signed GET URL for a single object. TTL is intentionally
// tight — the URL is opened immediately, not stored.
const VIEW_TTL_SECONDS = 120;

export async function signObjectUrl(bucketKey: string, key: string): Promise<string> {
  const entry = findEntry(bucketKey);
  const cfg = entry && resolveConfig(entry);
  if (!entry || !cfg) throw new BucketUnavailableError(bucketKey);

  return presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "GET",
    path: `/${cfg.bucket}/${key}`,
    expiresInSeconds: VIEW_TTL_SECONDS,
    now: new Date(),
  });
}
