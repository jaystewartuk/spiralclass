import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * No sentence appears twice in a document a stranger reads first.
 *
 * WHY THIS EXISTS. `scripts/readme-counts.mjs` holds every NUMBER in these
 * documents to the tree, on the rule that a claim nothing verifies is a claim
 * that is eventually false. Nothing held their PROSE, and on 2026-09-06 the
 * README lost two sentences and gained twenty-four.
 *
 * #1110 was sweeping mobile references out of the "Database" section. Its
 * replacement hunk applied twice: once where it belonged, and once over the tail
 * of the "Authentication and authorisation" paragraph, which then read
 *
 *     …the built-in allowlist constant is empty so it
 *     82 models, 2 migrations, 128 indexes and 23 unique constraints.
 *
 * and continued into a second copy of the whole Database section. It survived 34
 * commits and every gate run in between. Worse, `readme-counts.mjs --fix` went
 * on faithfully correcting the numbers inside the duplicate — 83 to 82, 130 to
 * 128 — because a duplicated paragraph states its counts correctly. The one
 * mechanism watching that region of the file was maintaining the damage.
 *
 * WHY SENTENCES AND NOT PARAGRAPHS. The duplicate was not byte-identical: the
 * original carried a trailing pointer at `apps/web/prisma/migrations/README.md`
 * and the copy did not, so any whole-block comparison passes. What repeated
 * verbatim was the sentences inside it, which is the durable signature of a
 * hunk applied in two places.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Headings, tables, fenced code and `→`
 * pointer lines are stripped first — those repeat on purpose. A table row saying
 * "Active" in forty places is an index doing its job, and the same
 * `→ docs/architecture/data-model.md` closing two related sections is a
 * signpost, not a duplication. The 60-character floor is what keeps short
 * connective prose ("This is the one that matters.") from being a finding.
 *
 * A REAL REPEAT IS A REAL FINDING. If this fails on something deliberate, the
 * fix is to say it once and link to it — not to add an exception list. These
 * documents are read start to finish by people deciding whether to trust the
 * rest of the repository, and the second time a reader meets the same sentence
 * they stop believing the first one was written on purpose.
 */

/**
 * The documents a stranger meets before any code. Deliberately a superset of
 * `readme-counts.mjs`'s CHECKED list: that one is about numbers, which only some
 * of these state, while every one of these is read cover to cover.
 */
const FRONT_DOOR = [
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/security.md",
  "docs/architecture/overview.md",
  "docs/architecture/data-model.md",
  "docs/development/setup.md",
  "docs/development/testing.md",
  "docs/development/workflow.md",
  "docs/decisions/README.md",
];

/** Shortest run of prose treated as a sentence rather than as connective tissue. */
const MIN_SENTENCE = 60;

/** Drops everything that repeats by design. */
function proseOnly(markdown: string): string {
  const kept: string[] = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|/.test(line)) continue; // table row
    if (/^\s*#/.test(line)) continue; // heading
    if (/^\s*→/.test(line)) continue; // pointer line
    if (/^\s*<!--/.test(line)) continue; // comment
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Sentences, flattened across the line wrapping Prettier imposes. Splits on
 * terminal punctuation followed by something that can open a sentence, which
 * keeps "e.g." and "D-42." from splitting mid-thought more often than not —
 * an over-split only ever produces a SHORTER candidate, and short candidates
 * fall under the floor rather than becoming false findings.
 */
function sentences(prose: string): string[] {
  return prose
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z*`[_])/)
    .map((s) => s.trim().replace(/[*_`]/g, ""))
    .filter((s) => s.length >= MIN_SENTENCE);
}

describe("the front-door documents say each thing once", () => {
  it.each(FRONT_DOOR)("%s repeats no sentence", (doc) => {
    const seen = new Map<string, number>();
    for (const sentence of sentences(proseOnly(readFileSync(join(REPO_ROOT, doc), "utf8")))) {
      seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
    }

    const repeated = [...seen]
      .filter(([, count]) => count > 1)
      .map(([sentence, count]) => `  ×${count}  ${sentence.slice(0, 120)}…`);

    expect(
      repeated,
      `${doc} says the same thing twice. Either an edit applied in two places — ` +
        "which is how the README carried a duplicate Database section for 34 " +
        "commits — or prose that should be said once and linked to. Do not add " +
        "an exception list.\n" +
        repeated.join("\n"),
    ).toEqual([]);
  });

  it("reads enough prose to be checking anything", () => {
    // Guards the guard: a stripper that dropped everything, or a splitter that
    // produced nothing over the floor, would pass every case above having
    // compared no sentences at all.
    const readme = sentences(proseOnly(readFileSync(join(REPO_ROOT, "README.md"), "utf8")));
    expect(readme.length).toBeGreaterThan(100);
  });
});
