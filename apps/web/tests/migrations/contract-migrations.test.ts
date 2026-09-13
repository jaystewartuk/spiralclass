import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A destructive migration names itself a contract (D-178).
 *
 * A production deploy migrates before its new code is live, and since D-177's
 * addendum the database job can succeed while the Fly job fails. Old code
 * therefore meets every new schema, for the length of a build at least. A
 * migration that drops, renames or narrows something breaks that code, unless
 * it ships a release after the code that stopped using it.
 *
 * This cannot see what production is serving. What it holds is that the author
 * had to stop and say so: a comment containing `CONTRACT`, naming what shipped
 * first. That is the moment the check against the live commit happens.
 */

const MIGRATIONS = resolve(process.cwd(), "prisma", "migrations");

/** The squashed history builds from nothing, so it has no serving code to break. */
const SQUASHED = new Set(["20260906120000_schema_baseline", "20260906120100_database_invariants"]);

const DESTRUCTIVE =
  /\b(?:DROP\s+(?:TABLE|COLUMN|TYPE|VIEW|INDEX|CONSTRAINT|SCHEMA)|RENAME\s+(?:COLUMN|TO|CONSTRAINT|VALUE)|ALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE|SET\s+NOT\s+NULL|TRUNCATE)\b/i;

/** The SQL a migration executes, with `--` comments removed. */
const executable = (sql: string) =>
  sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

const declaresContract = (sql: string) => /^\s*--.*\bCONTRACT\b/m.test(sql);

function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => statSync(join(MIGRATIONS, name)).isDirectory() && !SQUASHED.has(name))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8") }));
}

describe("destructive migrations declare themselves contracts (D-178)", () => {
  it("recognises what it is looking for", () => {
    // Guards the guard: a regex that matched nothing would pass every migration.
    for (const statement of [
      'DROP TABLE IF EXISTS "intro_calls";',
      'ALTER TABLE "teachers" DROP COLUMN IF EXISTS "x";',
      'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
      'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
      'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE INTEGER;',
      'DROP TYPE "Status";',
    ]) {
      expect(DESTRUCTIVE.test(statement), statement).toBe(true);
    }
    for (const statement of [
      'ALTER TABLE "a" ADD COLUMN "b" TEXT;',
      'CREATE INDEX "i" ON "a"("b");',
      "-- we used to DROP TABLE here",
    ]) {
      expect(DESTRUCTIVE.test(executable(statement)), statement).toBe(false);
    }
    expect(declaresContract("-- ⚠️ CONTRACT, NOT EXPAND: ships after a7fd8a5")).toBe(true);
    expect(declaresContract('DROP TABLE "CONTRACT";')).toBe(false);
  });

  it("reads the migrations directory", () => {
    expect(readdirSync(MIGRATIONS).some((name) => SQUASHED.has(name))).toBe(true);
  });

  it("every migration after the squash that takes something away says CONTRACT", () => {
    const offenders = migrations()
      .filter(({ sql }) => DESTRUCTIVE.test(executable(sql)) && !declaresContract(sql))
      .map(({ name }) => name);

    expect(
      offenders,
      "These migrations drop, rename or narrow something without a `-- … CONTRACT …` comment. " +
        "Ship the code that stops using it first, then add the comment naming that release (D-178).",
    ).toEqual([]);
  });
});
