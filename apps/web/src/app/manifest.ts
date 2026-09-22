import type { MetadataRoute } from "next";
import { palette } from "@spiralclass/shared";
import { getPreferredLocale, getT } from "@/lib/i18n";

/**
 * The PWA manifest — what an installed app shows on a home screen.
 *
 * TWO THINGS WERE WRONG HERE, and both were the same mistakes made a second
 * time somewhere nobody looks:
 *
 * `theme_color` was `palette.primary`. That is the indigo, not a ground, so an
 * installed app framed its chrome in a brand colour — the identical bug the
 * `<meta name="theme-color">` tag had (see lib/theme-color.ts), in a second
 * file, found only because the first one was. It is the page background now,
 * which is what the field means.
 *
 * The description was hardcoded Spanish and opened with the literal word
 * "Agenda" — the pre-rename product name sitting in the install prompt of a
 * product called SpiralClass. It comes from the catalog now, so it follows the
 * reader's locale like everything else.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getT();
  const locale = await getPreferredLocale();

  return {
    name: "SpiralClass",
    short_name: "SpiralClass",
    description: t("web.manifest.description"),
    lang: locale,
    start_url: "/",
    display: "standalone",
    background_color: palette.background,
    // The ground, not the brand colour. An installed app paints its chrome
    // with this, so a primary here reads as a coloured band above the page.
    theme_color: palette.background,
    icons: [
      {
        // NOT `/icon.svg`. That is Next's file-convention route, and its path
        // never changes when the file does — so Cloudflare, told
        // `max-age=31536000, immutable`, keeps serving whatever it cached
        // first. The HTML <link> gets a content hash appended and is therefore
        // fine; a manifest cannot append one, so an installed app fetched the
        // bare path and got a 28-hour-old copy of the PREVIOUS brand's icon.
        // Verified live: the origin served the ink mark while the edge served
        // the old terracotta monogram.
        //
        // The generated asset under /brand has the same problem in principle
        // and not in practice: it is written by scripts/brand-assets.mjs, so
        // its bytes change in the same commit as the design, and it is covered
        // by tests/config/svg-asset-parity.test.ts.
        src: "/brand/icon-tile.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      // NO `/apple-icon` ENTRY, for the reason directly above. It is Next's
      // dynamic metadata route, and `ImageResponse` serves it
      // `public, immutable, no-transform, max-age=31536000` — the same
      // cache-unstable stable path this comment was written about, sitting two
      // lines below it, declared in the one file that cannot append a hash.
      //
      // Removing it costs nothing. iOS does not take its home-screen icon from
      // the manifest; it reads `<link rel="apple-touch-icon">`, which Next
      // renders from apple-icon.tsx WITH a `?<contenthash>` query and which is
      // therefore already safe. Android has the SVG for `any` and the two
      // maskable PNGs, which is what a WebAPK actually installs.
      // Android crops a home-screen icon to the launcher's own shape. With no
      // maskable icon declared it refuses to crop and shows the mark in a white
      // box instead — which is what an install looked like until now, on the one
      // platform most of these teachers use.
      //
      // 192 and 512 as PNGs, not one `sizes="any"` SVG: Chrome accepts the SVG
      // and not every launcher does, and these are the two sizes the installer
      // actually looks for.
      {
        src: "/brand/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
