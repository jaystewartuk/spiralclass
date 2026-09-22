// View-model logic for the package editor (/settings/templates and the
// onboarding packages step). Pure functions, deliberately kept out of the
// React component: the web unit environment is `node`, so anything that only
// exists inside a component body can be checked by SSR markup assertions
// alone. Everything here — what a collapsed row summarises itself with, what
// counts as an unsaved change, what makes a row invalid, what a duplicate is
// called — is decided here and unit-tested directly.
//
// The server contract is untouched by any of it. `saveTemplatesAction` still
// receives the whole replace-set as index-aligned `tpl_*` arrays; these
// helpers only decide what the teacher SEES before she submits. In particular
// `packageRowIssue` mirrors `packageTemplateSchema`'s `superRefine` rather
// than inventing a second, stricter rulebook — a client that refuses what the
// server would accept is the same bug as one that accepts what the server
// refuses, just quieter.

import { computeWisePriceFromStripe } from "@spiralclass/shared";

/** A package as the server knows it. `id` is "" for a row added this session. */
export type PackageDraft = {
  id: string;
  name: string;
  /** Optional topic label — distinct from `name` (the size/duration label). */
  subject: string | null;
  classCount: number;
  /** Individual class sold one at a time; `classCount` is pinned to 1. */
  singleClass: boolean;
  classDurationMin: number;
  priceMinorUnits: number;
  /** null = no manual-rail discount (the transfer price inherits the card price). */
  transferPriceMinorUnits: number | null;
  expirationMonths: number | null;
};

/** A draft plus its client-side identity and whether it survives the next save. */
export type PackageRow = PackageDraft & {
  localKey: string;
  keep: boolean;
  /**
   * True while the transfer price tracks the auto-computed value; flips false
   * the moment the teacher hand-edits it, so changing the headline price later
   * doesn't blow away her override.
   */
  wiseAuto: boolean;
};

/** Column limits from `packageTemplateSchema`, so the field stops where
 * the server would truncate, rather than failing after a round-trip. */
export const PACKAGE_NAME_MAX_CHARS = 80;
export const PACKAGE_SUBJECT_MAX_CHARS = 60;

/**
 * Is this transfer price still the one we computed from the card price?
 *
 * `currency` is required, not optional with an MXN default: the discount maths
 * is currency-aware (D-143), and a 0-decimal currency answered against a
 * hardcoded exponent derives the wrong answer silently.
 */
export function deriveWiseAuto(
  priceMinorUnits: number,
  transferPriceMinorUnits: number | null,
  currency: string,
): boolean {
  if (transferPriceMinorUnits === null) return false;
  return transferPriceMinorUnits === computeWisePriceFromStripe(priceMinorUnits, currency);
}

// --- Validating a row -----------------------------------------------------

export type PackageRowIssue =
  "name-missing" | "class-count" | "duration" | "price-negative" | "expiration-missing";

/**
 * Why this row cannot be saved, or null.
 *
 * One rule per field, in the order the fields appear, so the first issue found
 * is also the first field to focus. Only `keep` rows are checked: a row she has
 * removed is about to be archived, and its contents no longer matter — which is
 * exactly what the schema's `superRefine` decides too.
 */
export function packageRowIssue(
  row: Pick<
    PackageRow,
    | "name"
    | "classCount"
    | "singleClass"
    | "classDurationMin"
    | "priceMinorUnits"
    | "expirationMonths"
    | "keep"
  >,
): PackageRowIssue | null {
  if (!row.keep) return null;
  if (!row.name.trim()) return "name-missing";
  const classCount = row.singleClass ? 1 : row.classCount;
  if (!Number.isInteger(classCount) || classCount < 1) return "class-count";
  if (!Number.isInteger(row.classDurationMin) || row.classDurationMin < 1) return "duration";
  if (!Number.isFinite(row.priceMinorUnits) || row.priceMinorUnits < 0) return "price-negative";
  if (row.expirationMonths === null || row.expirationMonths < 1) return "expiration-missing";
  return null;
}

/** Every issue in the current set, keyed by `localKey`. */
export function packageRowIssues(rows: Array<PackageRow>): Map<string, PackageRowIssue> {
  const issues = new Map<string, PackageRowIssue>();
  for (const row of rows) {
    const issue = packageRowIssue(row);
    if (issue) issues.set(row.localKey, issue);
  }
  return issues;
}

/**
 * The transfer price is at or above the card price — so the rail sold as
 * "pay by transfer and save" costs the student the same or more.
 *
 * A WARNING, not an issue: the server accepts it, some teacher may one day
 * mean it, and blocking a save on a price the schema allows would be this
 * form lying about what is possible. It is worth saying out loud because
 * nothing else in the product ever would: checkout simply charges
 * `transferPriceMinorUnits ?? priceMinorUnits` without comment.
 */
export function transferPriceIsNotADiscount(
  row: Pick<PackageRow, "priceMinorUnits" | "transferPriceMinorUnits" | "keep">,
): boolean {
  if (!row.keep) return false;
  if (row.transferPriceMinorUnits === null) return false;
  return row.transferPriceMinorUnits >= row.priceMinorUnits && row.priceMinorUnits > 0;
}

/**
 * What one class costs inside this package — the number a teacher actually
 * compares packages by, and the one figure the editor never showed her. Null
 * when it would be meaningless (no price, or a single class, where the package
 * price IS the per-class price).
 */
export function pricePerClassMinorUnits(
  row: Pick<PackageRow, "priceMinorUnits" | "classCount" | "singleClass">,
): number | null {
  if (row.singleClass) return null;
  if (row.priceMinorUnits <= 0) return null;
  if (!Number.isInteger(row.classCount) || row.classCount < 2) return null;
  return Math.round(row.priceMinorUnits / row.classCount);
}

// --- What is unsaved ------------------------------------------------------

export type PendingChanges = {
  added: number;
  edited: number;
  removed: number;
  /** Rows added, edited or removed — the number worth showing a teacher. */
  count: number;
  dirty: boolean;
};

const sameSubject = (a: string | null, b: string | null) => (a ?? "").trim() === (b ?? "").trim();

function isEdited(row: PackageRow, original: PackageDraft): boolean {
  return (
    row.name !== original.name ||
    !sameSubject(row.subject, original.subject) ||
    row.singleClass !== original.singleClass ||
    // A single-class row pins its count to 1; comparing the raw field would
    // report an edit for a count the form is about to overwrite anyway.
    (row.singleClass ? 1 : row.classCount) !== (original.singleClass ? 1 : original.classCount) ||
    row.classDurationMin !== original.classDurationMin ||
    row.priceMinorUnits !== original.priceMinorUnits ||
    row.transferPriceMinorUnits !== original.transferPriceMinorUnits ||
    row.expirationMonths !== original.expirationMonths
  );
}

/**
 * What this session would write if she saved now, against the list the server
 * last confirmed.
 *
 * This exists because the editor is a BATCH form: a teacher can reprice three
 * packages, remove a fourth, and lose all of it to one nav click. The summary
 * drives both the unsaved-changes bar and the beforeunload guard, so "is there
 * anything to lose" has exactly one definition.
 *
 * A row added and then removed in the same session is not a change at all —
 * nothing about it ever reached the server. Order is deliberately NOT part of
 * this: `PackageTemplate` has no position column, the server orders by
 * `createdAt`, and reporting a reorder the save cannot persist would promise
 * something untrue.
 */
export function pendingPackageChanges(initial: PackageDraft[], rows: PackageRow[]): PendingChanges {
  const byId = new Map(initial.map((t) => [t.id, t]));
  let added = 0;
  let edited = 0;
  let removed = 0;

  for (const row of rows) {
    if (!row.id) {
      if (row.keep) added++;
      continue;
    }
    const original = byId.get(row.id);
    // An id the server never confirmed (a stale row from a failed save) is not
    // something this summary can speak for.
    if (!original) continue;
    if (!row.keep) {
      removed++;
      continue;
    }
    if (isEdited(row, original)) edited++;
  }

  const count = added + edited + removed;
  return { added, edited, removed, count, dirty: count > 0 };
}

// --- Duplicating ----------------------------------------------------------

/**
 * A free name for a copy: "8 classes" becomes "8 classes (2)", again
 * "8 classes (3)". Duplicating an already-numbered copy increments rather than
 * nesting suffixes, and the result is clamped to the column's own limit so the
 * name the teacher sees is the name the server will store.
 */
export function duplicatePackageName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const trimmed = name.trim();
  const base = trimmed.replace(/\s*\(\d+\)$/, "") || trimmed;
  const clamp = (value: string) =>
    value.length > PACKAGE_NAME_MAX_CHARS
      ? value.slice(0, PACKAGE_NAME_MAX_CHARS).trimEnd()
      : value;
  for (let n = 2; n < 1000; n++) {
    const candidate = clamp(`${base} (${n})`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return clamp(base);
}
