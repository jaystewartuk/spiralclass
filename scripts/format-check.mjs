#!/usr/bin/env node
/**
 * Fail when any file in the tree is not Prettier-formatted.
 *
 * WHY THIS IS WHOLE-TREE, WHEN IT WAS DELIBERATELY NOT.
 *
 * It was scoped to the diff, and the reasoning was sound at the time: a
 * whole-repo gate failed on 1553 files, so turning it on meant landing a
 * 1553-file reformat that touched every Tier 2 path, conflicted with every open
 * branch, and buried any real change in it. The cost was real and the benefit
 * was cosmetic, so this checked what the branch touched and let the tree
 * converge as it was edited — the same ratchet shape as `diff-coverage.mjs` and
 * the i18n baseline.
 *
 * That premise is gone, in two steps. The ratchet worked: by 2026-09 the tree
 * was down from 1553 files to 385. Then #1119 reformatted those 385 and the
 * count reached zero. There is nothing left to grandfather, so the workaround
 * for having something to grandfather is now just a hole.
 *
 * AND IT IS A HOLE THAT HAS ALREADY BEEN PAID FOR ONCE. `prettier-plugin-tailwindcss`
 * went 0.6.14 → 0.8.1 inside a Dependabot group bump of 35 packages (#1103).
 * Its sort order changed and the tree was never reformatted — which this check,
 * by construction, could not see: on `main` nothing is changed against
 * `origin/main`, so a bump that invalidated a third of the `.tsx` tree left a
 * green gate behind it. The bill went to the next unrelated branch, where a
 * one-line comment change inherited 54 lines of class churn and a push tried to
 * reformat 385 files into a deletion PR. That reads as a mistake in review, and
 * the reviewer has to prove it is not one.
 *
 * This is a guard whose premise has died: it does not
 * announce it, it goes on making a workaround look load-bearing. Retiring the
 * ratchet is the other half of #1119's fix — that one made the tree clean, this
 * one makes it stay clean, and a dependency bump that changes formatter output
 * now reddens the gate on the commit that introduces it.
 *
 * WHAT IT COSTS: about 11 seconds on a fast tier that runs around 45, on every
 * push. That is the price of the failure above not recurring, and it is paid at
 * the only moment anyone can act on it.
 *
 * ⚠️ DELIBERATELY NOT `--cache`. Prettier can cache results and it would make
 * repeat runs near-instant, but the cache key is not guaranteed to include the
 * versions of the PLUGINS in `.prettierrc` — and a plugin version changing its
 * output is precisely the failure this exists to catch. A fast check that can
 * lie about exactly the case it was written for is worse than a slow one.
 *
 * WHAT IS SKIPPED, and by whom: Prettier 3 defaults `--ignore-path` to both
 * `.gitignore` and `.prettierignore`, so build output, `node_modules` and the
 * rest of the gitignored tree never get walked, and the two committed files that
 * must never be formatted (the generated ERD schema, the lockfile) are named in
 * `.prettierignore` with the reason beside each. Files Prettier has no parser
 * for — `migration.sql`, `migration_lock.toml` — are not picked up by a
 * directory walk at all. There is no third list here on purpose.
 *
 *   node scripts/format-check.mjs
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

try {
  execFileSync("pnpm", ["exec", "prettier", "--check", "."], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
} catch {
  console.error(
    `\n::error::The files listed above are not Prettier-formatted.\n` +
      `Run \`pnpm format\` and commit the result.\n` +
      `\nIf that rewrites files your branch never touched, a formatter or plugin\n` +
      `version has changed what Prettier produces. Land that reformat on its own,\n` +
      `not inside this branch — see this file's header for the last time it\n` +
      `happened.\n`,
  );
  process.exit(1);
}

console.log("\nformat-check: the whole tree is Prettier-formatted.");
