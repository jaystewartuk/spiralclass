import { describe, expect, it } from "vitest";
import { palette, paletteDark } from "@spiralclass/shared";
import { THEME_COLOR } from "@/lib/theme-color";

/**
 * The `theme-color` meta — the colour a mobile browser paints its own chrome.
 *
 * WHY THIS FILE EXISTS. These two values sat outside every guard the design
 * system had. `theme-parity` compares the shared palette against globals.css,
 * and `theme-color` is in neither, so it kept the pre-D-140 brand for as long
 * as nobody looked at a phone: `#FBF7F0` cream in light, and `#B8472E` — a
 * PRIMARY colour, never a background — in dark, which framed the page in
 * orange. Two guards passing is not the same as the surface being covered.
 */
describe("viewport theme-color", () => {
  const entries = THEME_COLOR as readonly { media: string; color: string }[];

  it("declares one colour per scheme", () => {
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.media)).toEqual([
      "(prefers-color-scheme: light)",
      "(prefers-color-scheme: dark)",
    ]);
  });

  it("is the page ground in each theme, taken from the palette", () => {
    // Identity with the palette, not merely "a plausible colour": the browser
    // chrome and the page must not be two different near-whites.
    expect(entries[0].color).toBe(palette.background);
    expect(entries[1].color).toBe(paletteDark.background);
  });

  it("is never a foreground or brand colour", () => {
    // The exact regression that shipped. A primary/accent value here reads as
    // a coloured band above the page on every phone.
    const forbidden = [
      palette.primary,
      palette.accent,
      palette.text,
      paletteDark.primary,
      paletteDark.accent,
      paletteDark.text,
    ].map((c) => c.toLowerCase());
    for (const entry of entries) {
      expect(forbidden).not.toContain(entry.color.toLowerCase());
    }
  });

  it("keeps the dark chrome darker than the light chrome", () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.replace("#", ""), 16);
      const c = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    expect(lum(entries[1].color)).toBeLessThan(lum(entries[0].color));
  });
});
