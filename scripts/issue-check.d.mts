// Types for the issue draft checker (scripts/issue-check.mjs). Kept as a
// sibling declaration so the checker stays a plain runnable .mjs while the
// guard test imports it with full types.

export const PRIORITY_LABELS: string[];
export const TYPE_LABELS: string[];

export interface IssueFindings {
  /** Anything that must be fixed before the draft is shown or filed. */
  errors: string[];
  /** Worth saying in the draft; does not fail. */
  warnings: string[];
}

/** Lint an issue draft, or an existing issue in audit mode. */
export function lintIssue(
  issue: { title: string; body: string; labels?: string[] },
  options?: { knownLabels?: Iterable<string>; scanLeaks?: boolean },
): IssueFindings;

/** Lower-case content words of three letters or more, stopwords removed. */
export function tokens(text: string): Set<string>;

/** Repo-relative paths named in backticks, line suffixes stripped. */
export function pathsIn(text: string): Set<string>;

export interface ExistingIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  stateReason?: string;
}

/** Rank existing issues by likeness to a draft; highest score first. */
export function similarIssues<T extends ExistingIssue>(
  draft: { title: string; body: string },
  issues: T[],
  options?: { limit?: number; threshold?: number },
): Array<T & { score: number; sharedPaths: string[] }>;
