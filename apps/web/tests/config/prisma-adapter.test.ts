import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { REPO_ROOT, walkTree } from "./_tree";
import { join, relative } from "node:path";

/**
 * Every PrismaClient in the repo is constructed with a driver adapter.
 *
 * WHY THIS IS A TEST AND NOT A TYPE. Since Prisma 7 the database URL is an
 * ARGUMENT — it left `datasource` in schema.prisma — so a client built without
 * one connects to nothing. But `new PrismaClient()` with no options is still
 * perfectly well-typed: the adapter is optional in the signature because
 * Accelerate takes `accelerateUrl` instead. `tsc` therefore cannot see this,
 * and it does not fail at import either. It fails on the first QUERY, with
 * "PrismaClient was instantiated without any options".
 *
 * That is exactly how it behaved during the 6 → 7 upgrade. Typecheck found the
 * three sites that passed the removed `datasources` option and stayed silent on
 * the eight that passed nothing — one browser-suite helper, and seven
 * operational scripts (backfills, cleanups, the importer) that no suite runs at
 * all. Those seven would have kept compiling, kept passing CI, and failed the
 * first time somebody reached for one, which is generally mid-incident.
 */
const WEB_ROOT = join(__dirname, "..", "..");
const SEARCH_DIRS = ["src", "scripts", "tests"];
/**
 * Comments and their prose are not code. Every file below TALKS about
 * `new PrismaClient()` — this one, the two library modules and the e2e helper
 * all explain the very hazard being guarded — and a scanner that cannot tell
 * an explanation from a construction reports its own documentation as the
 * offender.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every TypeScript file under `dir`, from `./_tree`, which skips whatever git
 * ignores. The hand-written skip list this replaced also named `generated`,
 * a directory that has never existed in this tree.
 */
const walk = (dir: string) => walkTree(dir, (name) => /\.tsx?$/.test(name));

describe("PrismaClient construction", () => {
  it("never happens without a driver adapter", () => {
    const offenders: string[] = [];

    for (const dir of SEARCH_DIRS) {
      for (const file of walk(join(WEB_ROOT, dir))) {
        const source = stripComments(readFileSync(file, "utf8"));
        for (const match of source.matchAll(/new PrismaClient\(([\s\S]{0,400}?)\)/g)) {
          const args = match[1];
          // `adapter:` directly, or a helper whose whole job is to return one.
          if (/adapter\s*:|adapter:\s*\w+\(\)/.test(args)) continue;
          if (/accelerateUrl\s*:/.test(args)) continue;
          offenders.push(relative(WEB_ROOT, file));
        }
      }
    }

    expect(
      [...new Set(offenders)],
      `These build a PrismaClient with no driver adapter, which since Prisma 7\n` +
        `connects to nothing. It compiles and it imports; it throws on the first\n` +
        `query. Pass one — \`envAdapter()\` from @/lib/db-pool is the DATABASE_URL\n` +
        `one that a bare constructor used to give you:\n${[...new Set(offenders)].join("\n")}`,
    ).toEqual([]);
  });

  it("finds the constructions it is meant to be checking", () => {
    // Guard the guard: a regex that matches nothing would pass the assertion
    // above for ever, on any tree, while asserting nothing at all.
    const found = SEARCH_DIRS.flatMap((dir) => walk(join(WEB_ROOT, dir))).filter((file) =>
      /new PrismaClient\(/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(found.length).toBeGreaterThanOrEqual(5);
  });
});
