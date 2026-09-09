import { describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";
import { palette } from "@spiralclass/shared";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => createT("es-MX"),
}));

const { default: manifest } = await import("@/app/manifest");

/**
 * The PWA manifest — what an installed app shows on a home screen.
 *
 * The description assertion used to pin a Spanish string literal, which passed
 * while the field WAS a hardcoded Spanish string in a trilingual product. It
 * now checks the property that actually matters (it comes from the catalog and
 * follows the locale), and the theme colour, which was `palette.primary` — the
 * same "a brand colour is not a background" bug the `<meta theme-color>` tag
 * had, in a second file, and unguarded in both.
 */
describe("manifest", () => {
  it("carries the brand name", async () => {
    const m = await manifest();
    expect(m.name).toBe("SpiralClass");
    expect(m.short_name).toBe("SpiralClass");
  });

  it("takes its description from the catalog, in the reader's locale", async () => {
    const m = await manifest();
    expect(m.description).toBe(createT("es-MX")("web.manifest.description"));
    // The pre-rename product name led this sentence, inside the install
    // prompt for a product called SpiralClass.
    expect(m.description).not.toMatch(/^Agenda,/);
    expect(m.description).not.toContain("español");
    expect(m.lang).toBe("es-MX");
  });

  it("paints its chrome with the page ground, never a brand colour", async () => {
    const m = await manifest();
    expect(m.background_color).toBe(palette.background);
    expect(m.theme_color).toBe(palette.background);
    // The exact regression: an installed app framed in indigo.
    expect(m.theme_color).not.toBe(palette.primary);
    expect(m.theme_color).not.toBe(palette.accent);
  });

  it("declares no icon at a path whose content can change beneath a cache", async () => {
    // /icon.svg is Next's file-convention route: a stable path served with
    // `immutable, max-age=31536000`. The HTML link gets a content hash; a
    // manifest cannot, so a bare reference pins an installed app to whatever
    // the CDN cached first — which is how production served the previous
    // brand's icon to installs while the origin served the current one.
    const m = await manifest();
    expect(m.icons?.map((i) => i.src)).not.toContain("/icon.svg");
  });

  it("declares the SVG, apple and maskable icons", async () => {
    const m = await manifest();
    expect(m.icons?.map((i) => i.src)).toEqual([
      "/brand/icon-tile.svg",
      "/brand/icon-maskable-192.png",
      "/brand/icon-maskable-512.png",
    ]);
  });

  it("declares every icon from the generated brand assets, and nothing else", async () => {
    // `/apple-icon` was in this list, two lines under the comment explaining
    // why `/icon.svg` could not be: it is Next's dynamic metadata route, and
    // ImageResponse serves it `immutable, max-age=31536000` at a path that
    // never changes. iOS takes its home-screen icon from
    // `<link rel="apple-touch-icon">`, which Next renders with a content hash,
    // so dropping it here loses nothing.
    const m = await manifest();
    for (const icon of m.icons ?? []) {
      expect(icon.src, `${icon.src} is not a generated brand asset`).toMatch(/^\/brand\//);
    }
  });

  it("declares a maskable icon, so Android crops rather than boxing it", async () => {
    // Without one, a launcher refuses to crop and shows the mark in a white
    // box. There was none until now — on the platform most of these teachers
    // use. The plan listed it in Phase 1 and it stayed open until Phase 5.
    const m = await manifest();
    const maskable = m.icons?.filter((i) => i.purpose === "maskable") ?? [];
    expect(maskable, "no maskable icon declared").not.toHaveLength(0);
    // Both sizes the installer looks for. One `sizes="any"` SVG satisfies
    // Chrome and not every launcher, which is why the plan named 192 and 512.
    expect(maskable.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(maskable.every((i) => i.type === "image/png")).toBe(true);
  });
});
