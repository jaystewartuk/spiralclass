import React from "react";
import { ImageResponse } from "next/og";
import { initialsFrom, palette } from "@spiralclass/shared";
import { ogFonts } from "@/lib/og-font";

// A seeded teacher's profile photo — an initials monogram, rendered here rather
// than pointed at.
//
// WHY THIS EXISTS. Every seeded teacher used to carry one hardcoded
// `photo_path`: the R2 key of the real production teacher's headshot, on the
// theory that "teacher photos are keyed by teacher id, this is the object
// migrated from prod". Preview and production do not share that bucket
// (`agendaprofe-preview-teacher-photos` vs `agendaprofe-production-teacher-photos`
// — infra/cloudflare-r2/variables.tf), and nothing ever copied the object
// across, so on preview the key resolved to a public URL that 404s. There is no
// fallback for that: AccountAvatar and the /b/<slug> hero both branch on the
// URL being *null*, so a non-null URL that 404s renders a broken image rather
// than the initials monogram. Preview showed every teacher — Alicia Moreno
// included, on the page the funnel is demoed from — as a broken image.
//
// So the seed no longer writes a pointer to an object it did not put there. It
// generates a monogram per teacher and uploads it under that teacher's OWN key
// (`teacherPhotoStorageKey(teacherId)` — production's own convention), which
// means the pointer is true in whatever bucket the seed ran against.
//
// WHY SATORI. `next/og` is already a first-class dependency with an inlined
// brand face (lib/og-font.ts, D-140), and it runs fine under plain `tsx` — no
// new dependency, no committed binary, and the monograms match the OG cards.
//
// `React.createElement` rather than JSX deliberately: this module is executed
// BOTH by Next's compiler and by `tsx scripts/seed.ts`, which resolves the
// classic JSX runtime from this workspace's `jsx: "preserve"` and needs `React`
// in scope. Spelling the call out works under either runtime with no pragma.

// Matches the largest width the booking-page hero requests (`lg:h-72` at 2x),
// so the monogram is never upscaled.
export const SEED_PHOTO_SIZE = 640;

// Foreground/background pairs taken from the solved brand palette rather than
// invented — every one of these is already contrast-checked (tokens.ts), so a
// seeded avatar cannot quietly fail AA the way a hashed HSL pair could. Six
// pairs is enough to tell fifteen seeded teachers apart at a glance.
const MONOGRAM_PAIRS = [
  { bg: palette.infoBg, fg: palette.info },
  { bg: palette.sageBg, fg: palette.sage },
  { bg: palette.clayBg, fg: palette.clay },
  { bg: palette.successBg, fg: palette.success },
  { bg: palette.warningBg, fg: palette.warning },
  { bg: palette.muted, fg: palette.primary },
] as const;

export type MonogramPair = (typeof MONOGRAM_PAIRS)[number];

// Deterministic per teacher (FNV-1a), so a re-seed re-uploads the same bytes
// and the `?v=` cache-buster is the only thing that moves.
export function monogramPairFor(key: string): MonogramPair {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return MONOGRAM_PAIRS[(hash >>> 0) % MONOGRAM_PAIRS.length]!;
}

/**
 * PNG bytes for a seeded teacher's placeholder photo. `image/png` is one of
 * ALLOWED_PHOTO_TYPES, so it passes the bucket's own MIME allowlist.
 */
export async function seedPlaceholderPhotoPng(
  name: string | null | undefined,
  email?: string | null,
): Promise<Buffer> {
  const { bg, fg } = monogramPairFor(`${name ?? ""}|${email ?? ""}`);
  const response = new ImageResponse(
    React.createElement(
      "div",
      {
        style: {
          width: SEED_PHOTO_SIZE,
          height: SEED_PHOTO_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: bg,
          color: fg,
          fontFamily: "Atkinson Hyperlegible",
          fontWeight: 700,
          // Two glyphs at ~40% of the canvas reads as an avatar at both the
          // 28px header size and the 288px booking-page hero.
          fontSize: Math.round(SEED_PHOTO_SIZE * 0.4),
          letterSpacing: -4,
        },
      },
      initialsFrom(name, email),
    ),
    { width: SEED_PHOTO_SIZE, height: SEED_PHOTO_SIZE, fonts: ogFonts() },
  );
  return Buffer.from(await response.arrayBuffer());
}
