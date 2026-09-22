#!/usr/bin/env node
// Mutation spot-check (TEST_AUDIT_2026-06-26.md, P3).
//
// Line coverage proves a line RAN under test; it does NOT prove a test would
// FAIL if that line were wrong — a line can execute via a mock and still have
// nothing assert its effect. This is the blind spot in a heavily-mocked unit
// suite. A full mutation-testing run (Stryker) over this monorepo is slow and
// heavy; instead this is a fast, dependency-free spot-check over the highest-
// consequence pure logic (money math + the subscription entitlements resolver).
//
// For each mutation it: patches one source line, runs the targeted test file(s),
// and asserts the run now FAILS ("the mutant was killed"). A mutant that
// SURVIVES — tests still green with wrong code — is a real defect-detection gap
// and fails this script. Sources are always restored (finally), and the run
// verifies a clean tree at the end.
//
// Run: `node scripts/mutation-spotcheck.mjs` (from apps/web), or
//      `pnpm --filter spiralclass-web mutation:spotcheck`.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** @type {Array<{file:string, find:string, replace:string, tests:string[], desc:string}>} */
const MUTATIONS = [
  {
    // Lives in toMajorUnits() since 2026-08-30 — the divisor both formatters
    // share. It was inline in formatMinorUnits, and a second formatter copying
    // the expression made this `find` ambiguous and took the full gate red.
    desc: "money: shared minor→major exponent off by one (every formatted amount 10× too large)",
    file: "../../packages/shared/src/money.ts",
    find: "minorUnits / 10 ** currencyExponent(code)",
    replace: "minorUnits / 10 ** (currencyExponent(code) - 1)",
    tests: ["tests/lib/money.test.ts"],
  },
  {
    desc: "money: minorUnitsToMajor exponent off by one (converted amount 10× too small)",
    file: "../../packages/shared/src/money.ts",
    find: "Math.round(minorUnits) / 10 ** currencyExponent(currency)",
    replace: "Math.round(minorUnits) / 10 ** (currencyExponent(currency) + 1)",
    tests: ["tests/lib/money.test.ts"],
  },
  {
    desc: "entitlements: trial-expiry comparison <= flipped to >= (active trial wrongly downgraded)",
    file: "../../packages/shared/src/subscriptions-entitlements.ts",
    find: "sub.trialEndsAt.getTime() <= now.getTime()",
    replace: "sub.trialEndsAt.getTime() >= now.getTime()",
    tests: ["tests/subscriptions/entitlements.test.ts"],
  },
  {
    desc: "entitlements: statusGrantsPro drops 'active' (active subs lose Pro)",
    file: "../../packages/shared/src/subscriptions-entitlements.ts",
    find: 'status === "trialing" || status === "active" || status === "past_due"',
    replace: 'status === "trialing" || status === "canceled" || status === "past_due"',
    tests: ["tests/subscriptions/entitlements.test.ts"],
  },
];

function runTests(tests) {
  try {
    execSync(`npx vitest run --project unit ${tests.join(" ")}`, {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
    });
    return 0; // tests passed → mutant SURVIVED
  } catch (err) {
    return err.status ?? 1; // non-zero → tests failed → mutant KILLED
  }
}

function main() {
  const results = [];
  for (const m of MUTATIONS) {
    const original = readFileSync(m.file, "utf8");
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      console.error(
        `::error::mutation target not unique in ${m.file} (${occurrences} matches): ${m.find}`,
      );
      console.error("The source moved — update scripts/mutation-spotcheck.mjs.");
      return 1;
    }
    const mutated = original.replace(m.find, m.replace);
    let killed = false;
    try {
      writeFileSync(m.file, mutated);
      killed = runTests(m.tests) !== 0;
    } finally {
      writeFileSync(m.file, original);
    }
    results.push({ desc: m.desc, killed });
    console.log(`${killed ? "✓ killed " : "✗ SURVIVED"}  ${m.desc}`);
  }

  // Belt-and-braces: make sure we left the tree exactly as we found it.
  try {
    const dirty = execSync(
      "git status --porcelain -- ../../packages/shared/src/money.ts ../../packages/shared/src/subscriptions-entitlements.ts",
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    ).trim();
    if (dirty) {
      console.error(`::error::mutation spot-check left the tree dirty:\n${dirty}`);
      return 1;
    }
  } catch {
    // git not available — skip the cleanliness assertion.
  }

  const survived = results.filter((r) => !r.killed);
  console.log(
    `\nmutation spot-check: ${results.length - survived.length}/${results.length} mutants killed.`,
  );
  if (survived.length > 0) {
    console.error("::error::Surviving mutants — these wrong-code changes did NOT fail any test:");
    for (const s of survived) console.error(`  - ${s.desc}`);
    console.error("Add/strengthen assertions in the targeted suites so the mutation is caught.");
    return 1;
  }
  console.log("mutation spot-check: OK — the targeted high-value logic detects faults.");
  return 0;
}

process.exit(main());
