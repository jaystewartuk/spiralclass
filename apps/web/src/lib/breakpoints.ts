/**
 * The responsive screen scale — one source of truth, because three consumers
 * have to agree on it or the layout tears in half: Tailwind's `theme.screens`
 * (every `sm:` / `md:` / `lg:` utility in the app), the raw media queries in
 * `src/app/globals.css` that can't be expressed as a utility (the
 * `.table-stack` row-to-card collapse, the Sentry widget offset), and the
 * tests that guard both.
 *
 * ## Why these numbers
 *
 * They are Tailwind's defaults, plus two pointer-gated screens for the app
 * shell (D-140). An earlier scale moved every breakpoint above the widest
 * tablet (1281px) so a tablet got the phone layout; it also gave the phone
 * layout to every laptop window narrower than 1281px, and was withdrawn. A
 * width cannot tell a 1280px tablet from a 1280px window; `pointer: fine` can.
 *
 * Real device CSS widths the tests still check against:
 *
 *   744 × 1133  iPad mini 6
 *   820 × 1180  iPad 10th gen / iPad Air 11"
 *   834 × 1194  iPad Pro 11"
 *   800 × 1280  the 800×1280dp Android tablet class, including the Amazon
 *               Fire HD 10 (9th gen) the first teacher works from: 1280 wide
 *               in landscape. It gets the touch shell because it has no fine
 *               pointer, not because of its width.
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
 * Tailwind's default scale, restored (D-140).
 *
 * An earlier scale (August 2026) replaced this wholesale — `sm` and `md` both moved to 1281px so every
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
 * A note on touch, because it is the thing the withdrawn 1281px scale was
 * really trying to express.
 *
 * "Is this a finger?" is not a width question, and answering it with one is
 * what forced every tablet onto the phone layout. The width tells you how much
 * room there is; `@media (pointer: coarse)` tells you what is pointing at it.
 * Target sizing belongs to the second. Note that Button, Input and Select are
 * 44px below `lg` and shrink to 40px (`lg:h-10`) by width alone, so a
 * landscape tablet 1024px or wider is handed 40px controls (D-140).
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
   * with a mouse. This is the query the withdrawn 1281px scale actually
   * wanted and could not say in a width alone.
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
