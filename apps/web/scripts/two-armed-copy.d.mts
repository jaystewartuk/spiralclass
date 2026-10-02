// Types for the two-armed copy scanner (scripts/two-armed-copy.mjs). A sibling
// declaration for the same reason i18n-guard has one: the scanner stays a plain
// runnable .mjs, and the ratchet test imports it with full types.
export const REPO_ROOT: string;
export const BASELINE_PATH: string;
export const SCAN_ROOTS: string[];

/** Count two-armed call sites in one source, ignoring comment lines. */
export function scanSource(source: string): number;

/** Map of repo-relative (posix) path → call-site count for every file with at
 * least one. */
export function collectCounts(repoRoot?: string): Record<string, number>;

/** Load the checked-in ratchet baseline. */
export function loadBaseline(): Record<string, number>;
