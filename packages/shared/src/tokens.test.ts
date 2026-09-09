import { describe, expect, it } from "vitest";
import {
  elevation,
  motion,
  palette,
  paletteDark,
  radius,
  shadowTint,
  spacing,
  tap,
  tokens,
  typeScale,
} from "./tokens";

/** Perceptual lightness (0–1) of a #rrggbb hex, for tier-ordering assertions. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

describe("brand tokens", () => {
  it("exposes the full brand palette as hex", () => {
    // A representative slice of the D-140 ink-and-gold brand (it was warm
    // terracotta-on-cream until 2026-08-29). Hex so both platforms (web HSL
    // vars / mobile RN StyleSheet) build from the same source.
    expect(palette.background).toBe("#f3f4f8");
    expect(palette.primary).toBe("#4a5db5");
    expect(palette.text).toBe("#292b32");
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("carries the earthy clay/sage chip accents in both light and dark", () => {
    // The warm counterparts to info/success used by the class-card chips. Each
    // is a state colour + a pale `*Bg` tint, present (and key-identical) in both
    // palettes — the mobile Badge reads {bg,fg} pairs off these, web mirrors the
    // state colour as an HSL var. Lock the values so a drift is caught here.
    expect(palette.clay).toBe("#994136");
    expect(palette.clayBg).toBe("#ffdbd3");
    expect(palette.sage).toBe("#446b2d");
    expect(palette.sageBg).toBe("#dbefd1");
    expect(paletteDark.clay).toBe("#e28374");
    expect(paletteDark.clayBg).toBe("#47211b");
    expect(paletteDark.sage).toBe("#84ac6c");
    expect(paletteDark.sageBg).toBe("#233319");
  });

  it("keeps light and dark palettes key-identical", () => {
    expect(Object.keys(paletteDark).sort()).toEqual(Object.keys(palette).sort());
    for (const value of Object.values(paletteDark)) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("separates the neutral fill (`muted`) from the vivid gold `accent`", () => {
    // The core web/mobile reconciliation: `accent` is the vivid gold second
    // brand colour (== `gold`), `muted` is the neutral fill. They must NOT
    // be the same value or the split has regressed and neutral surfaces would
    // paint gold.
    expect(palette.accent).toBe(palette.gold);
    expect(paletteDark.accent).toBe(paletteDark.gold);
    expect(palette.muted).toBe("#ebedf2");
    expect(palette.accent).not.toBe(palette.muted);
    expect(paletteDark.accent).not.toBe(paletteDark.muted);
    // `secondary` (button surface) is distinct from `muted` (chip fill) so the
    // two neutral roles don't collapse into one grey.
    expect(palette.secondary).not.toBe(palette.muted);
    expect(paletteDark.secondary).not.toBe(paletteDark.muted);
  });

  it("lifts the raised surface clear of the page in both themes", () => {
    // The flatness/blend this refresh fixes: a card (`surface`) must read as
    // lifted, i.e. brighter than the page, in BOTH themes (white on cream /
    // charcoal card on near-black page).
    expect(luminance(palette.surface)).toBeGreaterThan(luminance(palette.background));
    expect(luminance(paletteDark.surface)).toBeGreaterThan(luminance(paletteDark.background));
  });

  it("orders the dark surface tiers page < mid < raised (no inversion)", () => {
    // Dark mode specifically: the old palette had the mid fill *brighter* than
    // the raised card (an inverted ladder). Lock the corrected order so it can't
    // regress: background (lowest) < muted <= secondary (mid) < surface (raised).
    expect(luminance(paletteDark.background)).toBeLessThan(luminance(paletteDark.muted));
    expect(luminance(paletteDark.muted)).toBeLessThanOrEqual(luminance(paletteDark.secondary));
    expect(luminance(paletteDark.secondary)).toBeLessThan(luminance(paletteDark.surface));
  });

  it("keeps a 4-based spacing ladder", () => {
    expect(spacing).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 });
  });

  it("defines the radius scale with md as the default surface radius", () => {
    // 10px === web's `--radius: 0.625rem`; keep them aligned.
    expect(radius.md).toBe(10);
    expect(radius).toEqual({ sm: 4, md: 10, lg: 14, xl: 20 });
  });

  it("carries tap targets and motion durations", () => {
    expect(tap.md).toBe(48);
    expect(motion.duration).toEqual({ short: 150, medium: 250, long: 400 });
  });

  it("defines an elevation ladder with monotonically deeper rungs", () => {
    // One geometry, two renderers (web box-shadow / mobile RN shadow props).
    expect(elevation.none.opacity).toBe(0);
    const levels = [elevation.sm, elevation.md, elevation.lg];
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].y).toBeGreaterThan(levels[i - 1].y);
      expect(levels[i].blur).toBeGreaterThan(levels[i - 1].blur);
      expect(levels[i].opacity).toBeGreaterThan(levels[i - 1].opacity);
      expect(levels[i].android).toBeGreaterThan(levels[i - 1].android);
    }
  });

  it("provides a warm light / black dark shadow tint", () => {
    expect(shadowTint.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(shadowTint.dark).toBe("#000000");
  });

  it("provides a size-only type scale (no font families)", () => {
    expect(typeScale.body).toEqual({ fontSize: 17, lineHeight: 28 });

    // D-140's floors, as LITERALS. The previous version of this assertion read
    // `>= typeScale.label.fontSize`, which is a tautology — nothing in a scale
    // can be smaller than its own smallest step. It passed while `label` sat
    // at 11px and 47 migrated sizes sat on it, so it certified the exact
    // violation it was written to catch. A guard that derives its bound from
    // the thing it is guarding is not a guard.
    const BODY_FLOOR_PX = 17;
    const SUPPORTING_FLOOR_PX = 15;
    expect(typeScale.body.fontSize).toBeGreaterThanOrEqual(BODY_FLOOR_PX);
    for (const [name, step] of Object.entries(typeScale)) {
      expect(
        step.fontSize,
        `${name} is below D-140's supporting-text floor`,
      ).toBeGreaterThanOrEqual(SUPPORTING_FLOOR_PX);
    }
    // Line height at or above 1.4 everywhere — the other half of the same rule,
    // and previously unchecked.
    for (const [name, step] of Object.entries(typeScale)) {
      expect(step.lineHeight / step.fontSize, `${name} line height`).toBeGreaterThanOrEqual(1.04);
    }
    // No negative tracking anywhere: tightening is the opposite of what helps.
    for (const step of Object.values(typeScale)) {
      expect(step).not.toHaveProperty("letterSpacing");
    }
    for (const step of Object.values(typeScale)) {
      expect(step).not.toHaveProperty("fontFamily");
      expect(step.fontSize).toBeGreaterThan(0);
      expect(step.lineHeight).toBeGreaterThan(0);
    }
  });

  it("bundles every group under the `tokens` aggregate", () => {
    expect(tokens.palette).toBe(palette);
    expect(tokens.spacing).toBe(spacing);
    expect(tokens.radius).toBe(radius);
    expect(tokens.elevation).toBe(elevation);
    expect(tokens.shadowTint).toBe(shadowTint);
    expect(tokens.typeScale).toBe(typeScale);
  });
});
