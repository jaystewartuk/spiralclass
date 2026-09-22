// Types for the internal-link checker (scripts/check-links.mjs). Kept as a
// sibling declaration so the checker stays a plain runnable .mjs (no build step
// for `node scripts/check-links.mjs`) while the guard test imports it with full
// types.

/** Pull literal internal links (href="/..." / href={"/..."}) out of one source. */
export function extractLinks(source: string): string[];

/** Strip query string and fragment from an href. */
export function normalizePath(href: string): string;

/** Derive the route table from src/app and check every literal internal link. */
export function checkLinks(): {
  routes: Array<{ regex: RegExp; source: string }>;
  broken: Array<{ href: string; file: string }>;
  checked: number;
};
