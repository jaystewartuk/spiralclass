import { describe, expect, it } from "vitest";
import { elevation, palette, radius, typeScale } from "@spiralclass/shared";
import tailwindConfig from "../../tailwind.config";

// Guards the web side of the shared-token bridge: the web app must consume the
// same brand values mobile does, not a hand-copied fork. If someone re-types a
// hex into the Tailwind config, these fail.
//
// This used to assert through `lib/brand-tokens.ts`, a module that re-exported
// the shared tokens unchanged and was imported by nothing but this file — so
// the test proved a re-export re-exported, and the indirection made the real
// subject (the Tailwind config) harder to see. The module is deleted; these
// assertions now read the shared package directly.
describe("web brand-token bridge", () => {
  it("exposes the shared palette as Tailwind `brand` colours", () => {
    const extend = (tailwindConfig.theme as { extend?: Record<string, unknown> }).extend ?? {};
    const colors = (extend.colors ?? {}) as Record<string, unknown>;
    expect(colors.brand).toEqual(palette);
  });

  it("exposes the shared radius scale as rounded-brand-* utilities", () => {
    const extend = (tailwindConfig.theme as { extend?: Record<string, unknown> }).extend ?? {};
    const borderRadius = (extend.borderRadius ?? {}) as Record<string, string>;
    expect(borderRadius["brand-sm"]).toBe(`${radius.sm}px`);
    expect(borderRadius["brand-md"]).toBe(`${radius.md}px`);
    expect(borderRadius["brand-xl"]).toBe(`${radius.xl}px`);
  });

  it("makes every step of the shared type scale reachable as a class name", () => {
    // The other half of the `text-label` bug (guarded from the call-site side
    // in tests/config/d140-rules.test.ts). This scale existed in packages/shared
    // from the start and was not wired into Tailwind for its whole life, which is
    // the MECHANICAL reason 47 arbitrary sizes grew underneath `text-xs`: a
    // scale nobody can reach is a scale nobody uses. If a step is ever dropped
    // from the spread again, every class naming it goes back to emitting
    // nothing — silently, because Tailwind does not error on a class it cannot
    // resolve.
    const extend = (tailwindConfig.theme as { extend?: Record<string, unknown> }).extend ?? {};
    const fontSize = (extend.fontSize ?? {}) as Record<string, [string, { lineHeight: string }]>;
    for (const [step, { fontSize: px, lineHeight }] of Object.entries(typeScale)) {
      expect(fontSize[step], `text-${step} resolves to no font-size`).toEqual([
        `${px / 16}rem`,
        { lineHeight: `${lineHeight / 16}rem` },
      ]);
    }
  });

  it("puts nothing under the 15px floor D-140 states for supporting text", () => {
    // Both scales at once: the shared steps above, and Tailwind's own keys,
    // which this config REDEFINES rather than leaves at stock (stock `text-xs`
    // is 12px and `text-sm` 14px, and between them they carry ~1,300 call
    // sites). A step below the floor is exactly how `label` shipped as a named
    // violation the first time — the name made it look decided.
    const extend = (tailwindConfig.theme as { extend?: Record<string, unknown> }).extend ?? {};
    const fontSize = (extend.fontSize ?? {}) as Record<string, [string, unknown]>;
    for (const [step, [size]] of Object.entries(fontSize)) {
      expect(
        parseFloat(size) * 16,
        `text-${step} is ${size}, under the 15px floor`,
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it("derives the shadow-brand-* scale from the shared elevation tokens", () => {
    // The box-shadow strings must be built from the shared `elevation` geometry
    // (same numbers mobile's buildElevation reads) and tinted via the
    // theme-swapping --shadow-color var, not hand-authored — otherwise the two
    // platforms' elevation drifts.
    const extend = (tailwindConfig.theme as { extend?: Record<string, unknown> }).extend ?? {};
    const boxShadow = (extend.boxShadow ?? {}) as Record<string, string>;
    for (const level of ["sm", "md", "lg"] as const) {
      const e = elevation[level];
      expect(boxShadow[`brand-${level}`]).toBe(
        `0 ${e.y}px ${e.blur}px 0 hsl(var(--shadow-color) / ${e.opacity})`,
      );
    }
  });
});
