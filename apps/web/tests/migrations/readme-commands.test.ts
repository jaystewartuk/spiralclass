import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `prisma/migrations/README.md` is the procedure an operator runs against
 * production's database, once, with no rehearsal on the night.
 *
 * On 2026-09-12, the morning production was due to adopt the squashed history,
 * its verification step still read `--from-url` and `--to-schema-datamodel`.
 * Prisma 7 removed the first and renamed the second, so the one check that
 * stands between `migrate resolve` and a live database would have died on an
 * unknown flag. `scripts/ci/integration.sh` had already been corrected, with a
 * comment saying so — the document an operator actually reads had not, and
 * nothing ran it.
 *
 * So this runs it. Every `prisma migrate …` command in the README's shell
 * blocks is checked against the installed CLI's own `--help`, and the
 * regeneration command is executed and must still reproduce the baseline. No
 * database is needed for either.
 */

const webRoot = resolve(process.cwd());
// Resolved the way `pnpm exec` finds it, not by path: the install is hoisted
// to the repository root, so apps/web has no node_modules/.bin of its own.
const prismaCli = createRequire(resolve(webRoot, "package.json")).resolve("prisma/build/index.js");
const readme = readFileSync(resolve(webRoot, "prisma/migrations/README.md"), "utf8");
const baseline = readFileSync(
  resolve(webRoot, "prisma/migrations/20260906120000_schema_baseline/migration.sql"),
  "utf8",
);

function prisma(args: string[]): string {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: webRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // No URL: neither command below may need a database, and an inherited one
    // must not be the reason a check passes.
    env: {
      ...process.env,
      DATABASE_URL: "",
      DIRECT_URL: "",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      CHECKPOINT_DISABLE: "1",
    },
  });
}

/** Every `prisma migrate <sub> …` line in a bash/sh fence, continuations joined. */
function migrateCommands(markdown: string): { sub: string; line: string }[] {
  return [...markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)]
    .flatMap((fence) => fence[1].replace(/\\\n\s*/g, " ").split("\n"))
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /\bprisma migrate ([a-z]+)\b/.exec(line);
      // From `prisma` on: a `pnpm --filter … exec` prefix carries pnpm's flags.
      return match ? [{ sub: match[1], line: line.slice(match.index) }] : [];
    });
}

const commands = migrateCommands(readme);

describe("the migrations README's commands run on the installed Prisma", () => {
  it("finds the commands it is meant to check", () => {
    // A fence renamed to ```shell would otherwise pass this suite vacuously.
    expect(commands.map((c) => c.sub)).toEqual(expect.arrayContaining(["diff", "resolve"]));
  });

  const subcommands = [...new Set(commands.map((c) => c.sub))];

  it.each(subcommands)(
    "names only flags `prisma migrate %s --help` lists",
    (sub) => {
      const known = new Set(prisma(["migrate", sub, "--help"]).match(/--[a-z][a-z-]*/g));
      const named = commands
        .filter((c) => c.sub === sub)
        .flatMap((c) => c.line.match(/--[a-z][a-z-]*/g) ?? []);

      expect(named.filter((flag) => !known.has(flag))).toEqual([]);
    },
    60_000,
  );

  it("regenerates the baseline byte for byte, below its comment header", () => {
    const regenerate = commands.find((c) => c.line.includes("--from-empty"));
    expect(regenerate).toBeDefined();

    const args = regenerate!.line.slice(regenerate!.line.indexOf("prisma ") + "prisma ".length);
    const body = baseline.replace(/^(?:--[^\n]*\n)+\n/, "");

    expect(body.length).toBeLessThan(baseline.length);
    expect(prisma(args.split(/\s+/))).toBe(body);
  }, 60_000);
});
