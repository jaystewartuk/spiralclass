import { fileURLToPath } from "node:url";

import postcss, { type AcceptedPlugin } from "postcss";
import { describe, expect, it } from "vitest";

// Why this test exists, in one sentence: under Tailwind 3, a child's own
// `mt-*` did not work inside a `space-y-*` container, and under Tailwind 4 it
// does — which moved real pages by up to 128px with nothing in the markup
// changing.
//
// v3 emitted:
//     .space-y-6 > :not([hidden]) ~ :not([hidden]) { margin-top: 1.5rem }
// Specificity (0,3,0): one class plus two `:not([hidden])` attribute
// selectors. A child's `.mt-14` is (0,1,0) and LOST. So
// `<section class="mt-14">` inside `<div class="space-y-6">` rendered a 24px
// gap, not 56px — silently, with the class sitting right there in the markup.
//
// v4 emits:
//     :where(.space-y-6 > :not(:last-child)) { margin-block-end: … }
// `:where()` is specificity zero on purpose, so the child's `mt-14` now wins
// and the gap is the 56px the markup always asked for. Measured on the real
// pages when the engine moved: about +128px (four sections × 32px), features
// +56, pricing +48, and — where a child's margin was SMALLER than the
// container's rhythm — booking −28 and the design-system page −31.
//
// That is the correct behaviour and the app is written against it now. The
// hazard is the reverse: if a future release drops the `:where()` wrapper, or
// this repo pins a version that predates it, every one of those gaps silently
// collapses back to the container's rhythm and the pages quietly restyle
// themselves again. Nothing else in the suite would notice — the visual
// baselines would, but only after someone regenerated them, which is exactly
// when a person is least likely to question a diff they just asked for.
//
// Compiled here rather than read off a build artifact so the test needs no
// `next build` and answers for the version actually installed.

const FROM = fileURLToPath(new URL("./space-y-specificity.css", import.meta.url));

async function compile(source: string): Promise<string> {
  const tailwind = (await import("@tailwindcss/postcss")).default;
  // Cast: @tailwindcss/postcss's exported plugin type recurses deeply enough
  // that tsc gives up comparing it to AcceptedPlugin ("excessive stack depth").
  const plugin = tailwind({ optimize: false }) as AcceptedPlugin;
  const result = await postcss([plugin]).process(source, { from: FROM });
  return result.css;
}

describe("space-y-* stays overridable by a child's own margin", () => {
  it("wraps the space-y selector in :where(), so it carries no specificity", async () => {
    const css = await compile(`@import "tailwindcss";\n@source inline("space-y-6");`);

    const rule = css.match(/[^\n}]*\.space-y-6[^{]*\{/)?.[0]?.trim();
    expect(
      rule,
      "no .space-y-6 rule was generated — this test is not checking anything",
    ).toBeTruthy();

    expect(
      rule,
      `space-y-6 compiled to "${rule}". Without the :where() wrapper this selector ` +
        `out-specifies a child's own mt-*/mb-*, and every place in the app that sets ` +
        `one inside a space-y container silently loses it — see the header of this file ` +
        `for the pages that moved when this changed.`,
    ).toMatch(/^:where\(/);

    // The v3 shape, spelled out so the failure message can name what came back.
    expect(rule).not.toMatch(/:not\(\[hidden\]\)\s*~\s*:not\(\[hidden\]\)/);
  });

  it("puts the rhythm on margin-block-end of every child but the last", async () => {
    // The other half of the v3 → v4 change, and the reason a child's `mb-*`
    // can now collide with the container where its `mt-*` used to.
    const css = await compile(`@import "tailwindcss";\n@source inline("space-y-6");`);
    const body = css.match(/:where\(\.space-y-6[^{]*\{([^}]*)\}/)?.[1] ?? "";

    expect(body).toContain("margin-block-end");
    expect(css).toMatch(/:where\(\.space-y-6\s*>\s*:not\(:last-child\)\)/);
  });
});
