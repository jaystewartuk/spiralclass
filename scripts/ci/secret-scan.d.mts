// Types for the credential scan (scripts/ci/secret-scan.mjs). Kept as a sibling
// declaration so the script stays a plain runnable .mjs while the guard test
// imports its pure half with full types — same arrangement as
// scripts/check-leaks.d.mts and scripts/ci/steps.d.mts.

export interface GitleaksFinding {
  /** Repo-relative path, as gitleaks reports it. */
  File: string;
  StartLine: number;
  RuleID: string;
}

/**
 * Split gitleaks findings by whether git would publish the file they are in.
 *
 * `ignoredPaths` is injected rather than called directly so the partition is
 * testable without a git repo: it takes the finding paths and returns the
 * subset git is excluding.
 */
export function partitionFindings(
  findings: GitleaksFinding[],
  ignoredPaths: (paths: string[]) => Set<string>,
): { publishable: GitleaksFinding[]; excluded: GitleaksFinding[] };
