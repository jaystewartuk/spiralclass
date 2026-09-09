import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The seed's idempotent cleanup has to answer one question — "did I create this
// row?" — and for a long time it INFERRED the answer from email domains and id
// prefixes. That inference broke silently when D-138 renamed the product: every
// fixture email moved, previously-seeded rows stopped matching while keeping the
// unique booking slugs and `cus_seed_*` ids the next run needed, and the seed
// became un-rerunnable on preview while staying green on every freshly created
// database (CI, local).
//
// `seeded_at` is the recorded answer. These guard the two halves that make it
// work — it has to be WRITTEN on everything the seed creates, and it has to be
// READ by the cleanup — because either half silently going missing puts us back
// where we started, and the symptom would again appear only on a long-lived
// database that nobody runs CI against.
const SEED_SRC = readFileSync(join(process.cwd(), "scripts", "seed.ts"), "utf8");

describe("seed ownership marker", () => {
  it("stamps every teacher and student the seed creates", () => {
    // Each create must be followed by the marker. Counting is the cheap
    // approximation of "no create was missed": if someone adds an eleventh
    // create without stamping it, the counts diverge and this fails.
    const creates = SEED_SRC.match(/prisma\.(teacher|student)\.create\(/g) ?? [];
    const stamps = SEED_SRC.match(/seededAt: new Date\(\)/g) ?? [];

    expect(creates.length).toBeGreaterThan(0);
    expect(
      stamps.length,
      `${creates.length} teacher/student creates but ${stamps.length} seededAt stamps — ` +
        "an unstamped row cannot be cleaned up by a later reseed",
    ).toBe(creates.length);
  });

  it("reads the marker in the cleanup, for both teachers and students", () => {
    for (const which of ["seedTeacherWhere", "seedStudentWhere"]) {
      const start = SEED_SRC.indexOf(`const ${which} = {`);
      expect(start, `${which} not found`).toBeGreaterThan(-1);
      const block = SEED_SRC.slice(start, start + 1200);
      expect(block, `${which} must match on the recorded marker`).toContain(
        "seededAt: { not: null }",
      );
    }
  });

  it("keeps the legacy inference as well, not instead", () => {
    // Rows written before the column existed carry NULL and can be identified
    // no other way. Dropping these before such rows are gone would recreate the
    // exact orphaning this fixes.
    for (const marker of ["acct_seed_", "cus_seed_", "@agendaprofe.test"]) {
      expect(SEED_SRC, `legacy marker ${marker} still needed`).toContain(marker);
    }
  });

  it("never writes the marker outside the seed", () => {
    // The column's whole value is that ONLY the seed writes it. If application
    // code ever set it, a reseed would delete real rows — and the seed refuses
    // production, so nothing else would catch it.
    // Generated artifacts are excluded: the ERD snapshot is derived FROM the
    // schema, so it names every column by construction and says nothing about
    // who writes one.
    const appSrc = join(process.cwd(), "src");
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(`grep -rl "seededAt" ${appSrc} | grep -v "\\.generated\\." || true`, {
      encoding: "utf8",
    }).trim();
    expect(hits, `seededAt written outside the seed:\n${hits}`).toBe("");
  });
});
