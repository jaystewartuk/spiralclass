import { presignS3Url } from "@/lib/aws/sigv4";
import { r2BucketConfig, r2ObjectPath } from "@/lib/storage/provider";

// Generated podcast audio — stored in a dedicated Cloudflare R2 bucket
// ("material-podcasts") rather than the shared class-materials bucket, so its
// lifecycle (regenerate-replaces, cascade-delete-with-material) and its private
// signed-URL playback are cleanly separated. R2's zero egress fees matter here
// the same way they do for chat audio: every press of play is an egress event.
//
// Unlike chat-audio.ts (which presigns a PUT for the CLIENT to upload a recorded
// voice note), the podcast bytes are produced server-side by the Inngest job and
// uploaded from there — so this module PUTs the bytes directly. The object is
// private; playback is a short-lived signed GET, never a public URL.
//
// Config: MATERIAL_PODCASTS_R2_BUCKET + _ENDPOINT + _ACCESS_KEY + _SECRET
//         (+ optional _REGION, default "auto"), read via provider.ts's shared
// r2BucketConfig("material-podcasts"). Missing/invalid config degrades to an
// upload error, not a boot error.

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const OP_TTL_SECONDS = 300; // 5 min — server-side operations complete promptly

function r2Config() {
  return r2BucketConfig("material-podcasts");
}

/** Upload a generated podcast mp3 for a material and return its storage path.
 *  The server chooses the path — scoped under the teacher's + material's prefix
 *  — so nothing client-supplied decides where the object lands. `timestamp`
 *  makes each regeneration a fresh key (the old object is deleted separately),
 *  sidestepping any read-after-overwrite staleness on signed URLs. */
export async function uploadMaterialPodcast(
  teacherId: string,
  materialId: string,
  bytes: Uint8Array,
  timestamp: number,
): Promise<{ storagePath: string; error?: undefined } | { error: string }> {
  const cfg = r2Config();
  if (!cfg) return { error: "r2-not-configured" };
  const storagePath = `${teacherId}/${materialId}/${timestamp}.mp3`;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "PUT",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: OP_TTL_SECONDS,
    now: new Date(),
  });
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) return { error: `r2-put-http-${res.status}` };
    return { storagePath };
  } catch {
    return { error: "r2-put-failed" };
  }
}

/** HEAD the uploaded object so the job can confirm it actually landed before
 *  marking the podcast ready — a dangling "ready" pointing at nothing is worse
 *  than a failure. Returns the byte size, or null if it isn't there. */
export async function headMaterialPodcastObject(storagePath: string): Promise<number | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "HEAD",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: OP_TTL_SECONDS,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) ? len : 0;
  } catch {
    return null;
  }
}

/** Mint a short-lived signed GET URL for playback (24h TTL). Returns null when
 *  R2 isn't configured so callers fall back to "not available" rather than throw. */
export async function mintMaterialPodcastSignedUrl(storagePath: string): Promise<string | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  return presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "GET",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    now: new Date(),
  });
}

/** Delete a podcast object — on regeneration (replacing the prior audio) or
 *  when the material is deleted. Best effort: an orphaned object costs pennies,
 *  and S3 DELETE is 204 on success and on already-gone keys alike, so this is
 *  naturally idempotent. Callers treat `false` as log-and-continue. */
export async function deleteMaterialPodcastObject(storagePath: string): Promise<boolean> {
  const cfg = r2Config();
  if (!cfg) return false;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "DELETE",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: OP_TTL_SECONDS,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
