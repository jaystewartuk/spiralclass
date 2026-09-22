import { presignS3Url } from "@/lib/aws/sigv4";
import { r2BucketConfig, r2ObjectPath } from "@/lib/storage/provider";

// Read/delete access to the per-speaker audio objects in the R2 egress bucket
// (lesson-insights Phase B). The existing storage seam (Supabase signed URLs)
// can't address the egress bucket, so this is the Phase B doc's "direct R2
// client" fallback, built on the SigV4 presigner. Two operations:
//   - presignedGetUrl: a short-lived URL handed to the ASR vendor, which pulls
//     the audio itself (no bytes through our server).
//   - deleteObject: derive-then-discard — remove the raw audio once transcribed.
//
// Reuses the LIVEKIT_EGRESS_S3_* config (same bucket the egress writes to,
// recording.ts) via provider.ts's shared r2BucketConfig("recordings") — the
// "S3" in the env-var name is historical (named for the egress feature, not
// this module) and predates provider.ts's per-bucket prefix map.

export interface LessonAudioStore {
  presignedGetUrl(storageKey: string, ttlSeconds?: number): string;
  deleteObject(storageKey: string): Promise<void>;
}

const DEFAULT_TTL_SECONDS = 600; // 10 min — long enough for the vendor to fetch.

// The default R2-backed store, or null when the egress bucket isn't configured
// (so the pipeline degrades gracefully, like getVideoProvider()).
export function getLessonAudioStore(): LessonAudioStore | null {
  const cfg = r2BucketConfig("recordings");
  if (!cfg) return null;

  const pathFor = (key: string) => r2ObjectPath(cfg, key);

  return {
    presignedGetUrl(storageKey, ttlSeconds = DEFAULT_TTL_SECONDS) {
      return presignS3Url({
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secret,
        region: cfg.region,
        host: cfg.host,
        method: "GET",
        path: pathFor(storageKey),
        expiresInSeconds: ttlSeconds,
        now: new Date(),
      });
    },
    async deleteObject(storageKey) {
      const url = presignS3Url({
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secret,
        region: cfg.region,
        host: cfg.host,
        method: "DELETE",
        path: pathFor(storageKey),
        expiresInSeconds: DEFAULT_TTL_SECONDS,
        now: new Date(),
      });
      const res = await fetch(url, { method: "DELETE" });
      // S3 delete returns 204; treat an already-absent object (404) as success.
      if (!res.ok && res.status !== 404) {
        throw new Error(`r2-delete-http-${res.status}`);
      }
    },
  };
}
