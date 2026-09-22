import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ogFonts } from "@/lib/og-font";

/**
 * The brand face reaches the Satori-rendered images.
 *
 * Two separate things were wrong and the plan only recorded one. It said the
 * OG card rendered in the platform default serif because no font was loaded
 * into the `ImageResponse` — true. It also, independently, asked for
 * `fontFamily: "serif"` in its own root style, so supplying the face would have
 * changed nothing. Fixing either alone leaves a serif card.
 *
 * So this checks both ends: that the bytes load, and that nothing asks for a
 * serif.
 */
describe("OG image typography", () => {
  it("loads both weights of the brand face as real bytes", () => {
    const fonts = ogFonts();
    expect(fonts).toHaveLength(2);
    for (const font of fonts) {
      expect(font.name).toBe("Atkinson Hyperlegible");
      // A truncated or missing file would still be a Buffer; a real WOFF is
      // several KB, and Satori fails silently on a bad one.
      expect(font.data.length).toBeGreaterThan(5000);
    }
    expect(fonts.map((f) => f.weight).sort()).toEqual([400, 700]);
  });

  it("supplies WOFF, which Satori can read — not WOFF2, which it cannot", () => {
    const fonts = ogFonts();
    for (const font of fonts) {
      // WOFF magic number is "wOFF"; WOFF2 is "wOF2". Satori accepts the first
      // and silently ignores the second, falling back to its default serif.
      expect(font.data.subarray(0, 4).toString("latin1")).toBe("wOFF");
    }
  });

  it("asks for the brand face rather than a serif", () => {
    // The half the plan did not record. Belt and braces: a future edit that
    // reinstates a serif family would pass every other assertion here.
    for (const file of [
      "src/app/opengraph-image.tsx",
      "src/app/api/og/social-preview/[id]/route.tsx",
    ]) {
      const source = readFileSync(join(__dirname, "..", "..", file), "utf8");
      expect(source, `${file} asks for a serif`).not.toMatch(/fontFamily:\s*"serif"/);
    }
  });

  it("always returns at least one font, because Satori throws without one", () => {
    // This assertion replaces its own opposite. The first version returned an
    // empty array on a bad read, described as "degrading rather than throwing"
    // — but Satori REQUIRES a font and throws "No fonts are loaded" without
    // one, so the safe-looking fallback WAS the crash, and it took the
    // production build down. There is no graceful failure here; the load has
    // to be incapable of failing, which is why the bytes are inlined.
    expect(ogFonts().length).toBeGreaterThan(0);
  });
});
