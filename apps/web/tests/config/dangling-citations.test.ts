import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, walkTree } from "./_tree";

/**
 * No code comment cites a section of a document that is not in this repository.
 *
 * WHAT WENT WRONG. Before the work shipped, behaviour lived in a pre-launch
 * spec — `MVP.md` — plus four review documents: a teacher-onboarding activation
 * audit, a video-call analytics review, a captions access review, and a list of
 * product issues found by the pilot teacher. The code cited them by section:
 * `§13.2` for tenancy, `§6.6` for the cancellation rule, `§6.8` for overrides.
 * [D-110](../../../../docs/decisions/D-110.md) then deleted every one of those
 * documents, on the rule that `docs/features/` describes what was BUILT and a
 * plan for work is not a description of it. The citations stayed: 464 of them,
 * across 188 files, pointing at nothing.
 *
 * #1099 repointed the ones written next to a path. It could not see the rest —
 * a bare `§13.2` names no document — and its own commit message says so.
 *
 * WHY IT MATTERED MORE THAN IT LOOKS. The strongest argument against these was
 * already written down, in `lib/email/templates.ts`: a deduction email once
 * printed `§6.6` to a student, and the fix was to cite the cancellation policy
 * by name and link to it, because "recipients could do nothing with the
 * internal spec section number". A reader of the code is in the same position.
 *
 * WHAT THIS COSTS, stated plainly. `git grep '§13.2'` used to be an index of
 * all 70 tenancy-critical sites in a codebase whose only tenant isolation is an
 * application-level `where teacherId`. That index is not gone, but it is now
 * spelled in English — `git grep -i 'tenant isolation'` — and English is
 * fuzzier than a number. The trade was made deliberately: a pointer nobody can
 * follow is worth less than a phrase everybody can read.
 *
 * WHAT IS STILL ALLOWED, and why each is not the same thing:
 *   - a section of a PUBLISHED standard (`RFC 5545 §3.3.11`), which a reader
 *     can look up;
 *   - a numbered item of a decision record that is in this tree, cited as
 *     "D-19 item 6" rather than "D-19 §6" — the record is here, so the pointer
 *     resolves;
 *   - `Slice N`, which is not a pointer at all. It names a delivery milestone
 *     the way "Phase 2" does, and a reader loses nothing by not finding a
 *     document: "this arrived in slice 2b" is complete as it stands.
 */

/** A `§` followed by a number, in any tracked source file. */
const CITATION = /§\d/;

/**
 * The published standards a section number may still point into. Each is a
 * document a reader can fetch; that is the whole test for belonging here.
 *
 * ⚠️ This is not a general exception list. A section of something that is not
 * published, and not in this tree, has nowhere for a reader to go — which is
 * the entire finding. Do not add an internal document to it; delete the
 * citation and say what the section said.
 */
const PUBLISHED_STANDARDS = [/RFC\s?\d+/];

/** Lines that talk ABOUT the citations rather than making one. */
const SELF_REFERENTIAL = [
  "apps/web/tests/config/dangling-citations.test.ts",
  // Asserts an email body carries no section number, and quotes the one that
  // shipped to a student in order to say what it is guarding.
  "apps/web/tests/notifications/email-render.test.ts",
];

describe("no comment cites a document that is not here", () => {
  const offenders = walkTree(REPO_ROOT, (name) => /\.(ts|tsx|mjs|prisma)$/.test(name))
    .map((abs) => [relative(REPO_ROOT, abs), abs] as const)
    .filter(([rel]) => !SELF_REFERENTIAL.includes(rel))
    .flatMap(([rel, abs]) =>
      readFileSync(abs, "utf8")
        .split("\n")
        .map((line, i) => [rel, i + 1, line] as const)
        .filter(([, , line]) => CITATION.test(line))
        .filter(([, , line]) => !PUBLISHED_STANDARDS.some((rx) => rx.test(line)))
        .map(([r, n, line]) => `${r}:${n}\n      ${line.trim()}`),
    );

  it("names no section of a deleted spec or review", () => {
    expect(
      offenders,
      "A `§N` citation points at a document a reader cannot open — the pre-launch " +
        "spec and the four review documents were all deleted by D-110 once the work " +
        "shipped. Say what the section said, and link `docs/features/` if a document " +
        "still owns that behaviour. Do not add an exception.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("reads enough of the tree to be checking anything", () => {
    // Guards the guard: a walk that returned nothing, or a filter that excluded
    // everything, would pass the assertion above having read no file at all.
    expect(
      walkTree(REPO_ROOT, (name) => /\.(ts|tsx|mjs|prisma)$/.test(name)).length,
    ).toBeGreaterThan(1000);
  });
});
