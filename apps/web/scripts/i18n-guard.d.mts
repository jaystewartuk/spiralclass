// Types for the i18n guardrail scanner (scripts/i18n-guard.mjs). Kept as a
// sibling declaration so the scanner stays a plain runnable .mjs (no build
// step for `node scripts/i18n-guard.mjs --generate`) while the ratchet test
// imports it with full types.
export const WEB_SRC: string;
export const BASELINE_PATH: string;

/** Count catalog-bypassing user-facing literals in one TSX source. */
export function scanSource(fileName: string, source: string): number;

/** Map of repo-src-relative (posix) path → offender count for every file with
 * at least one offender. */
export function collectCounts(srcDir?: string): Record<string, number>;

/** Load the checked-in ratchet baseline. */
export function loadBaseline(): Record<string, number>;
