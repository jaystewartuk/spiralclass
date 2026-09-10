import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `outline-none` still compiles under Tailwind 4. It means something else.
//
// v3:  outline: 2px solid transparent; outline-offset: 2px
// v4:  outline-style: none
//
// The v3 spelling was never "no outline" — the transparent 2px outline is what
// Windows High Contrast / `forced-colors: active` turns into a REAL outline,
// because forced-colors also strips the box-shadow that every focus ring in
// this app is made of. So the pairing the whole codebase uses,
// `focus-visible:outline-none focus-visible:ring-…`, degrades in forced colours
// to an element with no focus indicator of any kind.
//
// v4 kept that behaviour under a new name. `outline-hidden` emits
// `outline-style: none` plus `@media (forced-colors: active) { outline: 2px
// solid transparent; outline-offset: 2px }` — verified in the built CSS.
//
// Nothing fails when this is got wrong: the build is green, every sighted
// mouse user sees the same ring, and the loss shows up only for someone using
// forced colours — which, in a design system whose whole premise is that
// legibility outranks identity (D-140), is the last place to let a regression
// hide. Hence a test rather than a note.
//
// 62 call sites were migrated with the Tailwind 4 bump. This keeps the 63rd
// from being written out of habit.

const WEB_ROOT = resolve(__dirname, "../..");
const SRC = join(WEB_ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(full)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC);

// A whole class token, so `outline-none` is caught but a longer name ending in
// it would not be. Variants (`focus-visible:outline-none`) are caught via the
// leading colon.
const V3_OUTLINE = /(?<=[\s"'`:])outline-none(?=[\s"'`])/;

describe("focus rings survive forced colours", () => {
  it("finds source files to check", () => {
    // Guards the guard.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
    expect(SOURCE_FILES.some((f) => f.endsWith("globals.css"))).toBe(true);
  });

  it("uses outline-hidden, never Tailwind 4's outline-none", () => {
    const offenders = SOURCE_FILES.filter((file) =>
      V3_OUTLINE.test(readFileSync(file, "utf8")),
    ).map((file) => relative(WEB_ROOT, file));

    expect(
      offenders,
      "`outline-none` means `outline-style: none` in Tailwind 4, which leaves these elements " +
        "with no focus indicator at all under forced colours — the ring is a box-shadow, and " +
        "forced colours removes it. Use `outline-hidden`, which keeps the transparent 2px " +
        `outline that forced colours renders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
