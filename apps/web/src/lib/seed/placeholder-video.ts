import { SEED_CLIP_BASE64 } from "./placeholder-video-data";

// The seeded teacher's intro video — the same defect, and the same fix, as
// placeholder-photo.ts.
//
// `introVideoPath` used to be one hardcoded key: the real production teacher's
// 6.3 MB clip in `agendaprofe-production-teacher-videos`. Preview reads
// `agendaprofe-preview-teacher-videos`, nothing copied the object across, and
// the seed uploaded nothing — so /b/paula-pagos rendered a <video> pointing at
// a 404 (measured 2026-08-31). Unlike a missing photo this one does not even
// degrade to a monogram; IntroVideoCard renders whenever the path is non-null.
//
// So the seed uploads what it points at here too. The clip is a still monogram
// held for four seconds rather than anything resembling a real teacher's
// recording — enough for the card to decode a first frame and play, and
// obviously a placeholder to anyone looking at preview.
//
// WHY THE BYTES ARE INLINE (and generated — scripts/seed-clip.ts): the preview
// reseed runs inside the deployed standalone build, which ships no repo files,
// so a committed .mp4 read off disk would fail precisely where it must work.
// lib/og-font.ts reached this same conclusion for the same reason.

export const SEED_VIDEO_CONTENT_TYPE = "video/mp4";

// Decoded once per process, not once per seeded teacher.
let cache: Buffer | null = null;

export function seedPlaceholderVideoMp4(): Buffer {
  if (!cache) cache = Buffer.from(SEED_CLIP_BASE64, "base64");
  return cache;
}
