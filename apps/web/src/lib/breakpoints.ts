/**
 * The responsive screen scale — one source of truth, because three consumers
 * have to agree on it or the layout tears in half: Tailwind's `theme.screens`
 * (every `sm:` / `md:` / `lg:` utility in the app), the raw media queries in
 * `src/app/globals.css` that can't be expressed as a utility (the
 * `.table-stack` row-to-card collapse, the Sentry widget offset), and the
 * tests that guard both.
 *
 * ## Why these numbers and not Tailwind's defaults
 *
 * Tailwind ships `sm:640 md:768 lg:1024`, which puts EVERY tablet — 744px in
 * portrait at the narrow end, 1280px in landscape at the wide end — on the
 * desktop side of the first two breakpoints. That is the wrong call for this
 * product:
 *
 *  - A tablet is a TOUCH device. The `sm:` variants on the form primitives are
 *    the mouse affordances (`h-11 lg:h-10` on Button/Input/Select — a 44px
 *    touch target shrinking to a 40px pointer target; `text-base lg:text-sm` —
 *    16px, the size that stops mobile Safari zooming the page on focus,
 *    dropping to 14px). Firing those on a tablet hands a finger the controls
 *    drawn for a cursor.
 *  - A tablet is NARROW. The page shells cap their reading width for a desktop
 *    line length (`container max-w-2xl` / `max-w-3xl`), which on a phone is
 *    inert — the cap is wider than the viewport — but on a 1280px landscape
 *    tablet leaves ~256px of empty gutter on each side of the content.
 *
 * So the scale is shifted wholesale: nothing fires below `DESKTOP_MIN_WIDTH`,
 * and a tablet renders exactly what a phone renders — full-bleed, single
 * column, touch-sized. See docs/decisions/D-122.md.
 *
 * ## The threshold
 *
 * `TABLET_MAX_WIDTH` is the widest viewport still treated as a tablet, taken
 * from real device CSS widths rather than a round number:
 *
 *   744 × 1133  iPad mini 6
 *   820 × 1180  iPad 10th gen / iPad Air 11"
 *   834 × 1194  iPad Pro 11"
 *   800 × 1280  the 800×1280dp Android tablet class — the widest of them.
 *               THIS IS THE ONE THAT MATTERS: the teacher works from an Amazon
 *               Fire HD 10 (9th gen), whose 1920×1200 panel at a 1.5 device
 *               pixel ratio is exactly 800 × 1280 CSS px. Held in a stand, in
 *               landscape, she is at 1280 — one pixel under the threshold.
 *
 * `DESKTOP_MIN_WIDTH` is one pixel past it, because CSS `min-width: N` MATCHES
 * a viewport of exactly N — at 1280px a `min-width: 1280px` query is already
 * live, which would hand the most common Android tablet in landscape the
 * desktop layout, i.e. precisely the bug this scale exists to fix.
 *
 * Deliberately on the desktop side: the 12.9" iPad Pro and Surface-class
 * devices (1366 / 1368 landscape). They share a width with the classic
 * 1366×768 laptop, so no threshold can separate them, and at 13" the desktop
 * layout is the better of the two answers.
 */

/** Widest viewport (CSS px) that still gets the full-bleed touch layout. */
/**
 * The width below which the product shows its stacked, touch-first layout.
 * 1023 rather than 1280: a landscape tablet is a device people expect the
 * roomy layout on, and the conventional switch is 1024.
 */
export const TABLET_MAX_WIDTH = 1023;

/** First width that gets the multi-column desktop layout. */
export const DESKTOP_MIN_WIDTH = TABLET_MAX_WIDTH + 1;

/**
 * Tailwind's default scale, restored (D-141, superseding D-122).
 *
 * D-122 replaced this wholesale — `sm` and `md` both moved to 1281px so every
 * tablet got the phone layout, `lg` to 1440 and `xl` to 1680, plus a bespoke
 * `roomy` at 640. The reasoning was that a tablet is a touch device and should
 * not inherit mouse-sized targets.
 *
 * That is true and is now solved where it belongs — in the target sizes
 * themselves (44px minimum everywhere, per D-140) rather than by moving the
 * layout breakpoints. Holding it in the breakpoints cost more than it bought:
 * there was no layout at all between 640 and 1281, so every width in that band
 * rendered a phone layout stretched across it, and nothing responded above
 * 1440 — the visual baseline shows the dashboard using under half the width at
 * 1920.
 *
 * Standard values also mean a reader of this codebase can trust what `md:`
 * does without opening a file first.
 */
/**
 * A note on touch, because it is the thing D-122 was really trying to express.
 *
 * "Is this a finger?" is not a width question, and answering it with one is
 * what forced every tablet onto the phone layout. The width tells you how much
 * room there is; `@media (pointer: coarse)` tells you what is pointing at it.
 * Target sizing belongs to the second — and under D-140 the minimum is 44px
 * everywhere regardless, so a landscape tablet on the desktop layout is not
 * handed mouse-sized controls.
 *
 * Use these breakpoints for layout. Use `pointer: coarse` if a control ever
 * needs to grow beyond the standing minimum.
 */
export const SCREENS = {
  sm: "640px",
  md: "768px",
  lg: `${DESKTOP_MIN_WIDTH}px`,
  /**
   * The shell switches to its sidebar layout: wide enough, AND being pointed at
   * with a mouse. This is the query D-122 actually wanted and could not say in
   * a width alone.
   *
   * It resolves two real observations at once. A laptop with a window narrower
   * than 1281px used to get the stacked phone layout — which is most
   * non-maximised windows, and is how the touch layout kept appearing on a
   * MacBook. And a 1280px landscape tablet used to be handed the desktop
   * layout by width, and that is a device class teachers really work on.
   * `pointer: fine` separates them; width never could.
   */
  desktop: { raw: `(min-width: ${DESKTOP_MIN_WIDTH}px) and (pointer: fine)` },
  xl: "1280px",
  /** The shell switches again to inline horizontal navigation. */
  "desktop-wide": { raw: "(min-width: 1280px) and (pointer: fine)" },
  "2xl": "1536px",
} as const;

export const CONTAINER_MAX_WIDTH = "1280px";

/**
 * Which layout a viewport width resolves to. Exported for the tests that
 * assert no tablet width can reach the desktop branch; the app itself decides
 * this in CSS, never in JS.
 */
export function layoutForWidth(width: number): "mobile" | "desktop" {
  return width >= DESKTOP_MIN_WIDTH ? "desktop" : "mobile";
}
