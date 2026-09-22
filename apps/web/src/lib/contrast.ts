/**
 * WCAG relative luminance and contrast, for asserting the palette in tests.
 *
 * Lives in src/ rather than in a test file because the ratio is a property of
 * the design system, not of one test — the `/design` page will render the same
 * matrix, and two implementations of a formula is one too many.
 */

/** sRGB channel to linear light. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const n = Number.parseInt(full, 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.1 contrast ratio, 1–21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.1 thresholds, named so a test reads as the rule it is checking. */
export const WCAG = {
  /** Body text. */
  AA: 4.5,
  /** Text at 18.66px bold or 24px regular, and non-text UI (1.4.11). */
  AA_LARGE: 3,
  /** Enhanced. The palette targets this for body text. */
  AAA: 7,
} as const;
