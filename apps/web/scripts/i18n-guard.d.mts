// Types for the i18n guard (scripts/i18n-guard.mjs). Kept as a sibling
// declaration so the scanner stays a plain runnable .mjs (no build step for
// `node scripts/i18n-guard.mjs`) while the test imports it with full types.
export const WEB_SRC: string;

/** Paths (relative to src/) that may hold literals, each with its reason. */
export const EXEMPT: Record<string, string>;

/** Every catalog-bypassing user-facing literal in one TSX source. */
export function findLiterals(fileName: string, source: string): { line: number; text: string }[];

/** How many literals one TSX source holds. */
export function scanSource(fileName: string, source: string): number;

/** Every literal in src/, outside EXEMPT, as "path:line  text". */
export function collectViolations(srcDir?: string): string[];
