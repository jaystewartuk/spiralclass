/**
 * Reading preferences — text scale, spacing and tint (D-140).
 *
 * WHY THESE EXIST AT ALL. Dyslexia does not present one way: preferred size,
 * spacing and ground vary enough between people that any fixed choice is a
 * compromise for most of them. The defaults below are the evidence-led
 * baseline; these three controls are the part that stops the system guessing.
 *
 * WHY THEY ARE NOT localStorage. Two constraints, both the same ones `locale`
 * has. They must apply on the FIRST paint — a preference read by client script
 * after hydration reflows the page under the reader, which is worse than not
 * offering it. And they must follow a person between her laptop and her phone.
 * So the value of record is a column on Teacher/Student, mirrored into a cookie
 * the server can read while rendering.
 *
 * WHY THIS FILE IS NOT server-only. The client control needs the same
 * constants and the same spacing table, and importing a `server-only` module
 * from a "use client" component fails the build. The request-scoped read lives
 * in reading-server.ts — the same split lib/i18n.ts and lib/i18n-translate.ts
 * already make, for the same reason.
 *
 * WHY THE SCALE IS A MULTIPLIER, not a pixel size. The browser's own font-size
 * setting is the more effective control — it is set once and applies to every
 * site — so this composes with it rather than overriding it. Nothing here pins
 * the root font size, and every size in the app is rem.
 */

export const READING_COOKIE = "reading";

export type ReadingPreferences = {
  /** Multiplier on the root font size. */
  scale: number;
  /** 0 normal, 1 wide, 2 widest. */
  spacing: 0 | 1 | 2;
  /** A warm tint over the page, for readers who find a neutral ground stark. */
  tint: boolean;
};

export const READING_DEFAULTS: ReadingPreferences = { scale: 1, spacing: 0, tint: false };

/** Offered scales. Bounded because an unbounded slider breaks every layout and
 * nobody can say which value they picked. */
export const READING_SCALES = [1, 1.125, 1.25] as const;

/**
 * The spacing steps, as CSS values. Line height moves with letter and word
 * spacing because opening one without the others makes lines collide.
 */
export const READING_SPACING = [
  { tracking: "0.012em", word: "0.04em", leading: "1.6" },
  { tracking: "0.045em", word: "0.12em", leading: "1.8" },
  { tracking: "0.075em", word: "0.2em", leading: "2" },
] as const;

const clampScale = (n: number): number =>
  READING_SCALES.includes(n as (typeof READING_SCALES)[number]) ? n : READING_DEFAULTS.scale;

const clampSpacing = (n: number): 0 | 1 | 2 => (n === 1 || n === 2 ? n : 0);

/** Serialise for the cookie. Compact and positional — this is read on every
 * server render, so it stays three characters rather than JSON. */
export function encodeReading(p: ReadingPreferences): string {
  return `${p.scale}|${p.spacing}|${p.tint ? 1 : 0}`;
}

export function decodeReading(raw: string | undefined): ReadingPreferences {
  if (!raw) return READING_DEFAULTS;
  const [scale, spacing, tint] = raw.split("|");
  return {
    scale: clampScale(Number(scale)),
    spacing: clampSpacing(Number(spacing)),
    tint: tint === "1",
  };
}

/**
 * The inline style applied to `<html>` on the server, so the first paint is
 * already correct.
 *
 * Returned as a style object rather than a class because the values are
 * continuous and a class per combination would be nine of them.
 */
export function readingStyle(p: ReadingPreferences): Record<string, string> {
  const spacing = READING_SPACING[p.spacing];
  return {
    "--reading-scale": String(p.scale),
    "--reading-tracking": spacing.tracking,
    "--reading-word": spacing.word,
    "--reading-leading": spacing.leading,
    "--reading-tint": p.tint ? "1" : "0",
  };
}
