import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, walkTree } from "./_tree";

// A VALUE THE SEED READS THAT NOTHING EXPORTS IS A SETTING THAT DOES NOTHING.
//
// `SEED_OPERATOR_EMAIL` and `SEED_PILOT_TEACHER_EMAIL` were read by
// `scripts/seed.ts` and exported by no script at all. Putting either of them
// into Infisical's `preview` environment therefore changed nothing: the seed
// carried on with its `.invalid` fallbacks, wrote them into `admin_users` and
// the pilot teacher's row, and said nothing about it. Every check anyone could
// have run — the value is in Infisical, the seed exits 0, the rows exist —
// passed while the feature was entirely inert.
//
// ⚠️ THE REGRESSION IS THE SHAPE, NOT THE TWO NAMES. Nothing stopped the third
// or fourth such variable appearing except somebody holding both lists in their
// head at once, and the lists live in different languages in different
// directories. So this derives one list from `seed.ts` and the other from
// `infra/infisical/seed-env.sh`, and requires the first to be a subset of the
// second. Adding `process.env.SEED_ANYTHING` to the seed fails here until
// somebody says, in the contract file, where the value comes from.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT DEMAND is that every read be fetched from
// Infisical. Three are rightly not: the two bulk-volume knobs are passed on the
// command line and differ every run, and `PROD_DB_HOSTS` is a production
// refusal guard that a preview seed wants UNSET. A guard that insisted on those
// would be wrong and would be deleted by whoever hit it. Naming them in the
// contract file's "NOT FROM INFISICAL" block, with a reason, is how they pass —
// and that block is checked too, so a name cannot linger there after the seed
// stops reading it.

const SEED_SRC = join(REPO_ROOT, "apps", "web", "scripts", "seed.ts");
const CONTRACT = join("infra", "infisical", "seed-env.sh");

const seedSource = readFileSync(SEED_SRC, "utf8");
const contractSource = readFileSync(join(REPO_ROOT, CONTRACT), "utf8");

/**
 * Every environment variable a TypeScript source actually READS.
 *
 * Comment lines are dropped first: `seed.ts` discusses `SEED_BULK_TEACHERS` in
 * prose several times, and a guard that counted prose would report names by how
 * often they were explained.
 */
function envReads(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const m of line.matchAll(
      /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*"([A-Z][A-Z0-9_]*)"\s*\])/g,
    )) {
      names.add((m[1] ?? m[2]) as string);
    }
  }
  return names;
}

/** The executable lines of a shell script — its comments are prose, not calls. */
const shellCode = (source: string) =>
  source.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/** Secret names actually passed to `infisical_export_secrets`, flags and `||` tail removed. */
function exportedSecrets(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of shellCode(source)) {
    const call = /\binfisical_export_secrets\b(.*)$/.exec(line);
    if (!call) continue;
    for (const m of call[1].split("|")[0].matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) names.add(m[0]);
  }
  return names;
}

/**
 * Is this call allowed to fail?
 *
 * Both shapes end in `||`, and the difference is what the branch does: the
 * REQUIRED fetch propagates (`|| return 1`), an OPTIONAL one prints a line
 * saying which fallback the seed will use and carries on.
 */
const isOptionalCall = (line: string) =>
  /\|\|/.test(line) && !/\|\|\s*(?:return|exit)\b/.test(line);

/**
 * The contract file's "NOT FROM INFISICAL" block: `NAME — reason`, one per
 * entry, continuation lines indented under it. Parsing stops at the first
 * executable line, so the exports below can never be read as exemptions.
 */
function notFromInfisical(source: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^#\s*NOT FROM INFISICAL\b/.test(l));
  if (start === -1) return entries;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim().startsWith("#")) break;
    const m = /^#\s+([A-Z][A-Z0-9_]{2,})\s+—\s*(\S.*)$/.exec(line);
    if (m) entries.set(m[1], m[2].trim());
  }
  return entries;
}

const reads = envReads(seedSource);
const exported = exportedSecrets(contractSource);
const exempt = notFromInfisical(contractSource);

/** Shell scripts that run the seed AND reach Infisical — the ones this contract binds. */
const seedRunners = walkTree(REPO_ROOT)
  .filter((f) => f.endsWith(".sh"))
  .map((f) => relative(REPO_ROOT, f))
  .filter((f) => {
    // Executable lines only. `infra/infisical/run.sh` is a general-purpose
    // wrapper whose usage block offers the seed as an EXAMPLE; a guard reading
    // its comments would bind a script that runs whatever it is handed.
    const code = shellCode(readFileSync(join(REPO_ROOT, f), "utf8")).join("\n");
    // `scripts/ci/e2e.sh` runs the seed and is rightly NOT here: it never
    // touches Infisical, because CI has none. The seed's fallbacks are the
    // whole point of that path.
    return /scripts\/seed\.ts/.test(code) && /infra\/infisical\//.test(code);
  });

describe("the seed's environment contract", () => {
  // Guards the guard. Every assertion below is a subset check, and a parser
  // that silently returned nothing would pass all of them having read nothing —
  // which is the exact failure shape this whole area keeps producing.
  it("parses both sides, and still tells prose from a call", () => {
    expect(reads.size).toBeGreaterThanOrEqual(7);
    expect(reads).toContain("DATABASE_URL");
    expect(reads).toContain("SEED_OPERATOR_EMAIL");

    expect(exported.size).toBeGreaterThanOrEqual(5);
    expect(exported).toContain("DATABASE_URL");
    expect(exempt.size).toBeGreaterThanOrEqual(3);

    // Prose is not a read, and prose is not an export.
    expect(envReads("// set process.env.NOT_REAL to override\n")).toEqual(new Set());
    expect(exportedSecrets("# infisical_export_secrets NOT_REAL\n")).toEqual(new Set());
    // A real read and a real call still register.
    expect(envReads('const x = process.env.REAL_ONE ?? "";')).toEqual(new Set(["REAL_ONE"]));
    expect(exportedSecrets("infisical_export_secrets REAL_ONE || { echo NOPE; }")).toEqual(
      new Set(["REAL_ONE"]),
    );

    // The two `||` shapes, which the one-per-line rule turns on.
    expect(isOptionalCall("  infisical_export_secrets A || { echo no A; }")).toBe(true);
    expect(isOptionalCall("  infisical_export_secrets A B || return 1")).toBe(false);
  });

  it("accounts for every value the seed reads", () => {
    const unaccounted = [...reads].filter((n) => !exported.has(n) && !exempt.has(n)).sort();
    expect(
      unaccounted,
      `scripts/seed.ts reads ${unaccounted.join(", ")}, and ${CONTRACT} neither exports ` +
        `it nor explains why it is not from Infisical. Setting it in Infisical would do ` +
        `nothing and nothing would say so. Add it to infisical_export_seed_secrets (on ` +
        `its own line, if it is optional) or to the NOT FROM INFISICAL block with a reason.`,
    ).toEqual([]);
  });

  it("keeps the two real inboxes on the exported side", () => {
    // The regression itself, pinned by name: both were read and never exported.
    // They stay OPTIONAL — CI and a fresh checkout have no Infisical and must
    // keep seeding the `.invalid` fallbacks — which is what the next test is.
    expect(exported).toContain("SEED_OPERATOR_EMAIL");
    expect(exported).toContain("SEED_PILOT_TEACHER_EMAIL");
  });

  it("fetches each optional secret on a line of its own", () => {
    // `infisical_secrets` answers with every key the caller named or none of
    // them. So a single call naming several optional keys exports NOTHING the
    // moment any one of them is unset — half-configured Infisical would look
    // exactly like empty Infisical, which is the bug this file is about.
    for (const line of shellCode(contractSource)) {
      if (!/\binfisical_export_secrets\b/.test(line)) continue;
      if (!isOptionalCall(line)) continue; // required, all-or-nothing by design
      const named = [...line.split("|")[0].matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((m) => m[0]);
      expect(
        named,
        `${CONTRACT} fetches ${named.join(" and ")} in one optional call; a missing one ` +
          `would drop the rest silently. Give each its own line.`,
      ).toHaveLength(1);
    }
  });

  it("lets no exemption outlive the read it excuses", () => {
    // When you retire a thing, retire its guard in the same change: an entry
    // here for a variable the seed no longer reads makes dead configuration
    // look load-bearing.
    const stale = [...exempt.keys()].filter((n) => !reads.has(n)).sort();
    expect(
      stale,
      `${CONTRACT} excuses ${stale.join(", ")} from Infisical, but scripts/seed.ts no ` +
        `longer reads it. Delete the entry.`,
    ).toEqual([]);
    // And an exemption is a reason, not a name on a list.
    for (const [name, reason] of exempt) {
      expect(reason.length, `${name} is exempted without a reason`).toBeGreaterThan(20);
      expect(exported, `${name} is both exported and exempted`).not.toContain(name);
    }
  });

  it("binds every Infisical-backed script that runs the seed", () => {
    expect(seedRunners.length).toBeGreaterThanOrEqual(2);
    for (const file of seedRunners) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        src,
        `${file} runs the seed against Infisical but does not source ${CONTRACT}, so it ` +
          `will seed on a different environment than the other scripts that do.`,
      ).toContain("infisical/seed-env.sh");
      expect(shellCode(src).join("\n")).toContain("infisical_export_seed_secrets");
    }
  });
});
