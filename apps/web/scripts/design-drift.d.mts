// Types for the design-system drift scanner (scripts/design-drift.mjs). Kept
// as a sibling declaration so the scanner stays a plain runnable .mjs (no
// build step for `node scripts/design-drift.mjs --generate`) while the ratchet
// test imports it with full types — the same arrangement as i18n-guard.d.mts.

/** One way a component can bypass the token layer. */
export type DriftCategory =
  | "rawHex"
  | "rawColorFn"
  | "rawPalette"
  | "arbitraryValue"
  | "rawButton"
  | "scrimOpacity"
  | "inlineStyle";

/** Per-file counts, keyed by category. Categories with a zero count are absent. */
export type DriftCounts = Partial<Record<DriftCategory, number>>;

export const WEB_SRC: string;
export const BASELINE_PATH: string;

/** Human label and the fix, so the test and the eslint rule quote one source. */
export const CATEGORIES: Record<DriftCategory, { label: string; remedy: string }>;

/** Files exempt from specific categories, each justified at its declaration. */
export const ALLOWLIST: Record<string, Partial<Record<DriftCategory, true>>>;

/** Count token bypasses in one source file, by category. */
export function scanSource(relPath: string, source: string): DriftCounts;

/** Map of src-relative (posix) path → per-category counts, for every file with
 * at least one bypass. */
export function collectCounts(srcDir?: string): Record<string, DriftCounts>;

/** Load the checked-in ratchet baseline. */
export function loadBaseline(): Record<string, DriftCounts>;

/** Totals per category across every file. Every category is present. */
export function totals(counts: Record<string, DriftCounts>): Record<DriftCategory, number>;
