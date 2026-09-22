import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brandPalette, palette, paletteDark } from "@spiralclass/shared";

/**
 * Every colour baked into a static brand asset is a palette value.
 *
 * `theme-parity` compares the shared palette against globals.css, which covers
 * the two places a colour is *declared* and neither of the places it is
 * *drawn*. The static SVGs in public/brand are generated from the palette by
 * scripts/brand-assets.mjs, so they should agree by construction — but "should
 * agree by construction" is exactly what was true of the email logo right up
 * until it shipped as a blank box, and of the favicon while it carried the
 * previous brand for a week.
 *
 * So this checks the artefact rather than the intent: read the files, pull out
 * every literal colour, and require each one to be a colour the design system
 * actually has. It catches a hand-edit, a stale generated file, and a
 * generator that quietly stops using a token — none of which the existing
 * parity test can see.
 */

const BRAND_DIR = join(__dirname, "..", "..", "public", "brand");

/** Every hex the system sanctions, lowercased. */
const KNOWN = new Set(
  [...Object.values(palette), ...Object.values(paletteDark), ...Object.values(brandPalette)]
    .filter((v) => typeof v === "string" && v.startsWith("#"))
    .map((v) => String(v).toLowerCase()),
);

describe("static brand assets", () => {
  const svgs = readdirSync(BRAND_DIR).filter((f) => f.endsWith(".svg"));

  it("finds the generated assets", () => {
    // Guards the guard: an empty directory would pass every assertion below.
    expect(svgs.length).toBeGreaterThan(5);
  });

  it("uses only palette colours", () => {
    const offenders: string[] = [];
    for (const file of svgs) {
      const source = readFileSync(join(BRAND_DIR, file), "utf8");
      for (const m of source.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        const hex = m[0].toLowerCase();
        if (!KNOWN.has(hex)) offenders.push(`${file}: ${hex}`);
      }
    }
    expect(
      offenders,
      `Colours in generated brand assets that are not palette values. These files ` +
        `come from scripts/brand-assets.mjs — regenerate rather than edit:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps `currentColor` variants free of baked colour", () => {
    // mark.svg and mark-mono.svg exist so a component can colour the mark from
    // its surface. A literal in either defeats the only reason they are separate
    // files from mark-ink.svg.
    for (const file of ["mark.svg", "mark-mono.svg"]) {
      const source = readFileSync(join(BRAND_DIR, file), "utf8");
      expect(source, `${file} should inherit its colour`).toContain("currentColor");
    }
  });
});
