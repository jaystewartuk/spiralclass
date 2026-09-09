// The gate's step registry — the single source of truth for what "green"
// means, on every machine that runs it (D-119).
//
// ⚠️ GitHub Actions is back ([D-157]) and this registry is STILL the only
// definition of the checks. `.github/workflows/gate.yml` runs
// `node scripts/ci/gate.mjs --tier fast` and lists no steps of its own. That
// is the condition on which restoring Actions was safe at all: part of what
// D-129 deleted was a dispatch-only copy of every gate job, which was a second
// definition of green waiting to drift. If a check is ever added to a workflow
// instead of to this file, that failure mode is back.
//
// The `replaces` field is provenance. It names the Actions job each step took
// over from in 2026-07/08 — files that were deleted and were NOT restored under
// their old names — so it is a historical note rather than a live claim, and
// nothing checks that those files exist. It is what makes the shape of a check
// readable when someone asks why it looks the way it does.
//
// TIERS
//   fast  — the PR gate. Run by `.githooks/pre-push` on the laptop AND by
//           gate.yml on a runner; either way the result is posted as the
//           `local-gate` commit status on the PR head. One registry, so the two
//           can only disagree about timing.
//   heavy — the mutation spot-check and the two suites that need Docker or a
//           browser, WITHOUT the fast half in front of them. Run by
//           heavy.yml on a runner, on every PR ([D-161]).
//   full  — fast + heavy. The promote gate: `pnpm promote` runs this on the
//           laptop before it fast-forwards `production`, and it is the tier
//           whose receipt certifies the commit that ships.
//
// ⚠️ THE HEAVY HALF IS NO LONGER LAPTOP-ONLY. D-157 recorded one concrete
// blocker — the visual baselines under apps/web/tests/visual were `-darwin.png`
// only, so `e2e` could not go green on Linux — and [D-161] removed it by
// committing a SECOND set of baselines, `-linux.png`, generated on
// `ubuntu-latest`. Both sets are live and neither is authoritative over the
// other: Playwright picks by `process.platform`, so the laptop asserts against
// darwin and the runner against linux. A route added or restyled needs BOTH
// regenerated, which is the standing cost this bought — see the header of
// scripts/ci/e2e.sh for how.
//
// Order matters. Steps run sequentially, cheapest-and-most-likely-to-fail
// first, so a formatting slip fails in seconds instead of after the E2E suite.
// Sequential is also a memory decision: `next build --turbopack` peaks ~3.5GB
// and the E2E suite runs a second production build, so overlapping them on a
// 16GB laptop trades a few minutes of wall clock for a swap storm.

/**
 * @typedef {Object} Step
 * @property {string}   id       CLI handle for --only / --skip
 * @property {string}   title    what gets printed
 * @property {"fast"|"heavy"} tier   which HALF the step is in, not which tier selects it
 * @property {string[]} cmd      argv, run from the repo root
 * @property {string}   replaces the Actions job this took over from (provenance only — those workflows are deleted, D-129)
 * @property {string[]} [needs]  external prerequisites ("docker")
 * @property {Object}   [env]    extra env for this step
 */

/** @type {Step[]} */
export const STEPS = [
  {
    id: "prisma",
    title: "Prisma client",
    tier: "fast",
    cmd: ["pnpm", "--filter", "spiralclass-web", "exec", "prisma", "generate"],
    replaces: "checks.yml · every job's `Generate Prisma client` step",
  },
  {
    id: "format",
    title: "Formatting (changed files)",
    tier: "fast",
    cmd: ["pnpm", "format:check"],
    replaces: "checks.yml · static",
  },
  {
    // Cheap, and it sits here because the README is the first thing a stranger
    // reads now the repository is public. Six of its counts were wrong at once
    // on 2026-09-04 — a hand-typed number cannot fail a build, so none of them
    // ever had. It covers the architecture and development documents too, so
    // that moving a sentence out of the README is not a silent way to stop
    // checking it. See scripts/readme-counts.mjs.
    id: "readme-counts",
    title: "Doc counts match the tree",
    tier: "fast",
    cmd: ["node", "scripts/readme-counts.mjs"],
    replaces: "nothing — no workflow ever checked this",
  },
  {
    id: "typecheck",
    title: "Typecheck",
    tier: "fast",
    cmd: ["pnpm", "typecheck"],
    replaces: "checks.yml · static",
  },
  {
    id: "lint",
    title: "Lint",
    tier: "fast",
    cmd: ["pnpm", "lint"],
    replaces: "checks.yml · static",
  },
  {
    id: "test-web",
    title: "Unit tests + coverage floors (web)",
    tier: "fast",
    cmd: ["pnpm", "--filter", "spiralclass-web", "test:coverage"],
    replaces: "checks.yml · test-web",
  },
  {
    // MUST stay immediately after test-web: it reads the coverage-final.json
    // that step writes (apps/web/vitest.config.ts lists the `json` reporter for
    // exactly this), so it is the one step whose position is a data dependency
    // rather than a cost ordering.
    //
    // Why it exists as its own step: the aggregate floor in vitest.config.ts is
    // a whole-tree average, so a brand-new file can land at 0% coverage and
    // still leave the floor green. This holds the ADDED lines of the diff to
    // their own threshold. It had been orphaned — apps/web/package.json defined
    // `diff:coverage` and nothing invoked it, on PR or anywhere else — so new
    // code was only ever measured by an average it could hide inside.
    id: "diff-coverage",
    title: "Diff coverage on new code (web)",
    tier: "fast",
    cmd: ["pnpm", "--filter", "spiralclass-web", "diff:coverage"],
    replaces: "checks.yml · test-web",
  },
  {
    // The hole this closes: the only unit step in this registry was filtered to
    // `spiralclass-web`, so `packages/shared` and `packages/livekit-captions-agent`
    // ran under `pnpm test` and under nothing the hook, the gate or the workflow
    // ever invoked. Three assertions in `packages/shared` sat red on `main` for
    // a day before anyone ran the workspace script by hand, and one of them was
    // the only place a real person's name survived a sanitising pass.
    //
    // Filtered by path rather than by package name, so a package added tomorrow
    // is covered without a second edit here — the failure mode above was a list
    // that did not grow.
    //
    // No coverage floor: these are pure libraries with no build step, and a
    // floor that nobody set deliberately is a number to argue with later.
    id: "test-packages",
    title: "Unit tests (shared packages)",
    tier: "fast",
    cmd: ["pnpm", "--filter", "./packages/*", "test"],
    replaces: "nothing — no workflow, hook or tier ever ran these",
  },
  {
    // The CREDENTIAL half of the leak gate. The other half —
    // scripts/check-leaks.mjs, covering this operator's account identifiers and
    // personal data — runs inside `test-web`, and neither subsumes the other:
    // a hand-written regex list is weakest exactly where high-entropy strings
    // are concerned, which is the half gitleaks' ~170 curated provider rules
    // and entropy analysis exist for.
    //
    // It was added on 2026-09-06 because the pre-publication audit's credential
    // pass was a MODEL reading greps. That is genuinely good at the contextual
    // half (a client's name in a comment, a colleague's address in a fixture)
    // and non-deterministic on the half that matters most here. Both scanners
    // now agree the tree is clean; the point is that one of them is repeatable.
    //
    // ⚠️ Wrapped, not bare, and the reason is not flakiness — gitleaks is local
    // and offline. It is that gitleaks does not respect .gitignore, and a gate
    // must assert about what will be COMMITTED. Bare, it reports 15 findings on
    // a clean tree, every one a real credential in a gitignored file it can
    // never publish; a gate that is red on every push gets skipped within a
    // week. See scripts/ci/secret-scan.mjs.
    id: "secret-scan",
    title: "Credential scan (gitleaks, publishable files only)",
    tier: "fast",
    cmd: ["node", "scripts/ci/secret-scan.mjs"],
    needs: ["gitleaks"],
    replaces: "nothing — no workflow ever ran a credential scanner",
  },
  {
    id: "audit",
    title: "Dependency audit (prod, high+)",
    tier: "fast",
    // Wrapped, not bare: the wrapper separates a finding (a verdict about this
    // tree, still red) from an unreachable advisory database (a fact about
    // npm, now a loud warning). See scripts/ci/audit.mjs — an npm outage on
    // 2026-09-03 reddened every gate in both tiers for over an hour.
    cmd: ["node", "scripts/ci/audit.mjs"],
    replaces: "checks.yml · static",
  },

  // ── full tier ──────────────────────────────────────────────────────────────
  {
    id: "mutation",
    title: "Mutation spot-check (money math + entitlements)",
    tier: "heavy",
    cmd: ["pnpm", "--filter", "spiralclass-web", "mutation:spotcheck"],
    replaces: "checks.yml · mutation",
  },
  {
    id: "integration",
    title: "Integration suite (real DB · next build · drift)",
    tier: "heavy",
    cmd: ["bash", "scripts/ci/integration.sh"],
    needs: ["docker"],
    replaces: "integration.yml",
  },
  {
    id: "e2e",
    title: "Browser suites: E2E, visual regression, accessibility",
    tier: "heavy",
    cmd: ["bash", "scripts/ci/e2e.sh"],
    needs: ["docker"],
    replaces: "e2e.yml",
  },
];

export const TIERS = ["fast", "heavy", "full"];

/**
 * Steps in a tier. A step declares which HALF it is in (`fast` or `heavy`);
 * a TIER is a selection over those halves, and `full` is both.
 *
 * `heavy` is new in [D-161] and it exists because the two halves stopped
 * running on the same machine. Before D-161 there was no way to ask for the
 * expensive suites WITHOUT the cheap ones in front of them, because there was
 * no reason to want one: the laptop ran both, and `full` meaning "everything"
 * was exactly right. `.github/workflows/heavy.yml` now runs integration and
 * the browser suites on a runner while the fast half is already being run —
 * on the same commit, by gate.yml and by the pre-push hook — so asking for
 * `full` there would re-run ten minutes of `test-web` to reach them.
 *
 * ⚠️ `full` is still every step, and still what `pnpm promote` runs. That is
 * the one tier whose meaning must not narrow: it certifies the exact commit
 * that ships, and a promote that skipped the fast half because "a runner did
 * it" would be trusting a green from another machine and another moment.
 */
export function stepsForTier(tier) {
  if (tier === "full") return STEPS;
  if (tier === "heavy") return STEPS.filter((s) => s.tier === "heavy");
  return STEPS.filter((s) => s.tier === "fast");
}
