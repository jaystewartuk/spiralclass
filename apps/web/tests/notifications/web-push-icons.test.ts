import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The icons a pushed notification renders with.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Both fields were `/icon.svg`, and both
 * were wrong for a different reason:
 *
 *   - `/icon.svg` is Next's file-convention route — a stable path served
 *     `max-age=31536000, immutable`. The HTML <link> gets a content hash
 *     appended; a service worker cannot append one, so every push fetched the
 *     bare path and the edge returned whatever it cached first. Months after
 *     the rename, a real notification on a real phone showed the previous
 *     brand's terracotta monogram beside a correct app icon. `manifest.ts` had
 *     already been fixed for exactly this and this file was missed, which is
 *     the argument for checking it rather than commenting on it.
 *   - Android reads only the ALPHA of `badge`. A filled tile there is a solid
 *     white square in the status bar, so it cannot be the same asset as `icon`
 *     even once the path is right.
 *
 * The service worker is plain JS with no exports and no DOM, so this reads the
 * shipped file. That is the artefact anyway — a bundler never touches it.
 */
describe("the push notification icons", () => {
  const sw = readFileSync(join(__dirname, "..", "..", "public", "sw.js"), "utf8");
  const field = (name: string) => sw.match(new RegExp(`\\n\\s*${name}: "([^"]+)"`))?.[1];

  it("takes both from the generated brand assets", () => {
    // The path half of the regression — a Next file-convention route, cached
    // immutable at the edge, pinning every subscriber to a retired brand — is
    // checked for the whole repo in tests/config/cache-unstable-asset-paths.
    // Everything in public/brand is written by scripts/brand-assets.mjs from
    // one source, so its bytes change in the same commit as the design.
    expect(field("icon")).toMatch(/^\/brand\//);
    expect(field("badge")).toMatch(/^\/brand\//);
  });

  it("uses the full-bleed tile for the large icon", () => {
    // Android crops the large icon to the launcher's shape; the maskable tile
    // is the one drawn with that safe area.
    expect(field("icon")).toBe("/brand/icon-maskable-192.png");
  });

  it("uses a stroke-on-transparent mark for the badge, not the filled tile", () => {
    // Only the alpha survives. A tile masks to a featureless square.
    const badge = field("badge");
    expect(badge).toBe("/brand/mark-ink.png");
    expect(badge).not.toBe(field("icon"));
    expect(badge).not.toMatch(/maskable|tile/);
  });

  it("points at files that exist", () => {
    for (const src of [field("icon"), field("badge")]) {
      expect(() => readFileSync(join(__dirname, "..", "..", "public", String(src)))).not.toThrow();
    }
  });
});
