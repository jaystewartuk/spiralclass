// Types for the ship-relevance rule (scripts/ci/relevance.mjs). Sibling
// declaration for the same reason steps.d.mts is one: the module stays a plain
// runnable .mjs with no build step, while the guard test
// (apps/web/tests/config/relevance.test.ts) imports it with full types.

/** Whether a set of changed files can affect what a deploy carries. */
export interface ShipTargets {
  web: boolean;
}

/**
 * @param files repo-relative paths, as `git diff --name-only` prints them.
 *   Anything unrecognised counts as affecting the deploy.
 */
export function changedTargets(files: string[]): ShipTargets;
