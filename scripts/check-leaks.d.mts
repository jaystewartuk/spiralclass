// Types for the credential/personal-data scanner (scripts/check-leaks.mjs).
// Kept as a sibling declaration so the scanner stays a plain runnable .mjs (no
// build step for `node scripts/check-leaks.mjs --generate`) while the guard test
// imports it with full types.

export const BASELINE_PATH: string;
export const GIVEN_NAMES_PATH: string;
export const PERSONAS_PATH: string;

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  snippet: string;
}

/** A full name found in the tree that fixture-personas.json does not declare. */
export interface PersonFinding {
  file: string;
  name: string;
}

/** Scan the repo once for credentials, identifiers, people and personal data. */
export function scanRepo(): {
  secrets: SecretFinding[];
  /** Account/tenant identifiers — zero tolerance, no baseline (D-158). */
  identifiers: SecretFinding[];
  /** Undeclared person names — zero tolerance, against a declared roster. */
  people: PersonFinding[];
  /** repo-relative path → count of personal-data hits, for files with any. */
  personal: Record<string, number>;
  /**
   * Repo-relative paths actually read, so a test can assert COVERAGE and not
   * just findings — a walk that stopped reaching a tree makes every
   * "nothing found" assertion pass by itself.
   */
  scanned: string[];
};

/**
 * Run the secret patterns against one file's text.
 *
 * Exported so the patterns can be driven directly. Asserting the repo is clean
 * cannot prove a pattern works: a missing pattern makes that assertion pass.
 */
export function findSecrets(relPath: string, source: string): SecretFinding[];

/** Run the account-identifier patterns against one file's text. See findSecrets. */
export function findIdentifiers(relPath: string, source: string): SecretFinding[];

/**
 * Run the people gate against one file's text.
 *
 * Finds a full name by shape — a first name from `given-names.json` followed by
 * a capitalised word — and returns the ones `fixture-personas.json` does not
 * declare, at most once per name per file.
 */
export function findPeople(relPath: string, source: string): PersonFinding[];

/**
 * Join every line to its successor, dropping a comment marker on the
 * continuation.
 *
 * The people gate reads this rather than the raw source: the names that
 * outlived three earlier sweeps of this repository all had a line break
 * between the first name and the surname.
 */
export function reflow(source: string): string;

/** Every name declared in fixture-personas.json — personas and not-people. */
export function declaredPeople(): Set<string>;

/** Load the checked-in personal-data ratchet baseline. */
export function loadBaseline(): Record<string, number>;

/** Compare current personal-data counts against the baseline. */
export function comparePersonal(
  current: Record<string, number>,
  baseline: Record<string, number>,
): {
  regressions: Array<{ file: string; count: number; allowed: number }>;
  improvements: Array<{ file: string; count: number; allowed: number }>;
};
