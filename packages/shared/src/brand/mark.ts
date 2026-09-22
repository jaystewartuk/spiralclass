// The mark, as geometry rather than as artwork.
//
// The name is the pedagogy: a spiral curriculum returns to the same material at
// increasing depth. So the mark is a logarithmic spiral, r = a·e^(bθ), and the
// FIRST pass is drawn in gold with the rest in ink — the same path, revisited
// further on. Two strokes, one curve, split at a parameter.
//
// WHY THIS FILE EXISTS. The previous mark's path data was copied by hand into
// sixteen places — six SVG files, four Satori renderers, the React component,
// the email shell, and a separately rescaled rewrite in icon.svg — carrying five
// hex values that had all drifted from the tokens. Every consumer now imports
// from here, and `pnpm brand:assets` regenerates the static files from it, so
// there is exactly one place the shape lives.
//
// Regenerate: node scripts/brand-assets.mjs

/** Full mark. Two-tone, for 48px and up. */
export const MARK = {
  viewBox: "0 0 48 48",
  strokeWidth: 4.62,
  /** The whole spiral, for single-colour use. */
  full: "M15.8 24.39C16.21 24.26 17.38 23.61 18.27 23.6C19.15 23.59 20.25 23.8 21.1 24.31C21.96 24.82 22.88 25.67 23.4 26.67C23.92 27.66 24.31 29.03 24.21 30.29C24.12 31.55 23.68 33.09 22.85 34.24C22.01 35.4 20.68 36.61 19.19 37.23C17.71 37.84 15.71 38.22 13.92 37.93C12.13 37.64 10 36.82 8.45 35.48C6.91 34.15 5.34 32.1 4.65 29.9C3.96 27.7 3.67 24.81 4.31 22.29C4.95 19.77 6.39 16.82 8.49 14.79C10.6 12.75 13.72 10.78 16.94 10.07C20.17 9.36 24.33 9.31 27.84 10.54C31.35 11.77 35.38 14.19 38.02 17.45C40.66 20.71 42.74 27.99 43.69 30.1",
  /** The opening pass — drawn in gold. */
  first:
    "M15.8 24.39C16.21 24.26 17.38 23.61 18.27 23.6C19.15 23.59 20.25 23.8 21.1 24.31C21.96 24.82 22.88 25.67 23.4 26.67C23.92 27.66 24.31 29.03 24.21 30.29C24.12 31.55 23.07 33.58 22.85 34.24",
  /** Everything after it — drawn in ink. */
  rest: "M22.85 34.24C22.24 34.74 20.68 36.61 19.19 37.23C17.71 37.84 15.71 38.22 13.92 37.93C12.13 37.64 10 36.82 8.45 35.48C6.91 34.15 5.34 32.1 4.65 29.9C3.96 27.7 3.67 24.81 4.31 22.29C4.95 19.77 6.39 16.82 8.49 14.79C10.6 12.75 13.72 10.78 16.94 10.07C20.17 9.36 24.33 9.31 27.84 10.54C31.35 11.77 35.38 14.19 38.02 17.45C40.66 20.71 42.74 27.99 43.69 30.1",
} as const;

/**
 * Simplified mark, for 32px and below.
 *
 * Fewer turns and a heavier relative stroke, because at favicon sizes the inner
 * coil of the full mark fills in and the gold pass becomes a smudge. Verified by
 * rendering at 16, 24 and 32 rather than assumed.
 */
export const MARK_SMALL = {
  viewBox: "0 0 48 48",
  strokeWidth: 6.88,
  full: "M26.02 17.95C26.58 17.74 28.14 16.88 29.33 16.69C30.52 16.5 31.89 16.51 33.15 16.82C34.41 17.13 35.77 17.71 36.89 18.54C38.01 19.38 39.12 20.52 39.89 21.82C40.66 23.12 41.28 24.73 41.51 26.34C41.73 27.96 41.68 29.81 41.22 31.51C40.77 33.21 39.94 35.03 38.78 36.53C37.62 38.03 36.03 39.5 34.25 40.5C32.47 41.51 30.28 42.31 28.09 42.56C25.89 42.82 23.38 42.69 21.09 42.03C18.81 41.37 16.36 40.2 14.36 38.58C12.36 36.96 10.42 34.77 9.11 32.33C7.8 29.89 6.78 26.9 6.49 23.92C6.21 20.94 6.45 17.54 7.41 14.46C8.37 11.38 11.47 6.94 12.28 5.44",
} as const;

/** Below this width, use MARK_SMALL. */
export const MARK_SIMPLIFY_BELOW = 48;
