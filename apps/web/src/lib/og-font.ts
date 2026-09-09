import { OG_FONT_BASE64 } from "./og-font-data";

/**
 * The brand face, as bytes, for Satori-rendered images (D-140).
 *
 * WHY IT MATTERS. `ImageResponse` rasterises in a worker with no access to the
 * page's webfonts, so with none supplied it falls back to a default serif.
 * Every OG card this product has produced rendered in a serif, for a brand
 * whose whole typographic argument is a specific sans chosen for letterform
 * legibility. The one image most people meet before the product was the one
 * image off-brand.
 *
 * The card ALSO asked for `fontFamily: "serif"` in its own root style, so
 * supplying the face without fixing that would have changed nothing. The plan
 * recorded only the first half.
 *
 * WHY THE BYTES ARE INLINE. Two earlier shapes failed. Reading the woff out of
 * node_modules works locally and breaks the build, because `output: standalone`
 * does not ship node_modules. And the fallback that was supposed to make a bad
 * read harmless — return no fonts — is itself the crash: Satori REQUIRES at
 * least one font and throws "No fonts are loaded" without one. There is no
 * graceful degradation available, so the load must not be able to fail. No
 * filesystem, no module resolution, no I/O.
 *
 * The data is generated from the npm package by scripts/og-font.mjs, so it is
 * versioned and regenerable rather than a binary someone dropped in.
 *
 * WOFF, not WOFF2: Satori reads the former and silently ignores the latter.
 */

export type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

// Decoded once per process, not per image request.
let cache: OgFont[] | null = null;

export function ogFonts(): OgFont[] {
  if (!cache) {
    cache = [400 as const, 700 as const].map((weight) => ({
      name: "Atkinson Hyperlegible",
      data: Buffer.from(OG_FONT_BASE64[weight], "base64"),
      weight,
      style: "normal" as const,
    }));
  }
  return cache;
}
