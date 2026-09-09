/**
 * Vitest project split, formerly vitest.workspace.ts.
 *
 * Two projects:
 *
 *   - `unit`        — every existing test file. Runs against in-memory
 *                     Prisma fakes; no DB. `pnpm test` selects this
 *                     project so the per-push run stays fast.
 *
 *   - `integration` — `**\/*.integration.test.ts`. Requires
 *                     TEST_DATABASE_URL and runs against a real Postgres
 *                     (docker-compose.test.yml). `pnpm test:integration`
 *                     selects it; the global-setup hook applies
 *                     migrations once and warns + exits 0 when the env
 *                     var is missing so CI stays green without a DB.
 *
 * Each project is defined standalone (no `extends`) because vitest
 * merges `test.include` from the extended config rather than
 * overriding, which would let the integration project pick up every
 * unit test file by accident.
 *
 * These lived in vitest.workspace.ts until the vitest 5 bump. Vitest 4
 * removed `defineWorkspace` and the separate workspace file; `test.projects`
 * here is the same split in its supported home. `--project unit` /
 * `--project integration` select them exactly as before.
 */

import { defineConfig } from "vitest/config";
import path from "node:path";

const sharedAlias = {
  "@": path.resolve(__dirname, "./src"),
};

export default defineConfig({
  test: {
    // Cap parallelism below the core count. Vitest's default is
    // availableParallelism() - 1, which saturates every core: on a 10-core M4
    // a full `test:coverage` run held ~750% CPU and pushed the machine to
    // Moderate thermal pressure (macOS's first throttling tier) on
    // 2026-08-31. Oversubscribed workers mostly contend rather than progress,
    // so the wall-clock cost of capping is small next to the heat saved.
    //
    // Set at the root so it applies to the whole run rather than being
    // restated per project. The integration project overrides parallelism for
    // itself (fileParallelism: false, below), which is what it needs.
    maxWorkers: 8,
    // The unit/integration split. Coverage (below) stays at this level: it is
    // resolved for the whole run, not per project.
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "unit",
          environment: "node",
          // .tsx variants cover view-layer tests that render a component via
          // renderToStaticMarkup (e.g. tests/settings/*-inline-validation.test.tsx)
          // — these were silently never executed before this glob included them.
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
          // tests/e2e is Playwright (a different runner with its own .spec.ts
          // suffix anyway) — excluded defensively in case files get added under
          // .test.ts there.
          exclude: ["**/node_modules/**", "tests/e2e/**", "**/*.integration.test.ts"],
          setupFiles: ["./tests/setup.ts"],
          globals: false,
          // Vitest's default is 5s, which this suite outgrew. Nothing here does 5s
          // of real async work — the cost is the FIRST dynamic import of a route
          // or page module, which pulls a large dependency tree through esbuild.
          // Under full parallelism (520 files) several land at 3.5–5s and tip over
          // the default, so runs failed intermittently on whichever files happened
          // to be scheduled together — the route-heavy ones most often. That
          // reads as a broken build and trains people to re-run rather than look.
          //
          // 20s is a deliberate ceiling, not "off": still low enough that a real
          // hang (an un-awaited promise, a missing mock leaving a live timer)
          // fails the run rather than stalling CI. If a test genuinely needs more
          // than this, that test is the thing to fix.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          globals: false,
          globalSetup: ["./tests/_setup/global-setup.ts"],
          // Integration tests run sequentially against a single test DB —
          // truncate-between-each parallel runs would clobber each other.
          //
          // This was `poolOptions: { forks: { singleFork: true } }` until the
          // vitest 5 bump. Vitest 4 REMOVED `test.poolOptions` and made its
          // contents top-level; a leftover `poolOptions` is not an error, it is
          // a deprecation warning and then silence — so the sequencing this
          // suite depends on would have gone on looking configured while every
          // file raced the others against one database. `fileParallelism: false`
          // is the supported spelling, and it pins maxWorkers to 1 for this
          // project on its own.
          pool: "forks",
          fileParallelism: false,
          // The SAME 20s ceiling the unit project takes above, and for a stronger
          // version of the same reason.
          //
          // This project had no timeout at all, so it ran at vitest's 5s default —
          // while doing the slowest work in the repo: real Postgres round trips,
          // sequentially, with a `truncateAll` across ~74 tables in a beforeEach.
          // The project that needed the raise least got it; the one that needed it
          // most was left on the default.
          //
          // It bit on 2026-09-01. `tests/marketing/profile.integration.test.ts`
          // finished its first test in 5,160ms against the 5,000ms cap and failed
          // a promote gate — not on behaviour, on 160ms of clock. Three re-runs
          // passed it in 287–314ms. That is precisely the outcome the unit
          // project's own note predicts: "runs failed intermittently on whichever
          // files happened to be scheduled together... That reads as a broken
          // build and trains people to re-run rather than look."
          //
          // Re-running is the expensive part. A red gate here stops a deploy, so
          // the cost of a flake is a 20-40 minute cycle plus the machine lock, and
          // the habit it teaches is to distrust the gate.
          //
          // 20s is a ceiling, not "off", exactly as it is for unit: a genuine hang
          // (an un-awaited promise, a transaction never committed) still fails the
          // run rather than stalling it. A test that truly needs more than this is
          // the thing to fix.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],

    // Global coverage config (read by `vitest run --coverage` regardless of
    // which workspace project runs). See vitest.workspace.ts for the
    // unit/integration split.
    coverage: {
      provider: "v8",
      // Measure the testable LOGIC layer: lib modules, server actions, and
      // API route handlers. React view components (.tsx under src/app and
      // src/components) are component/E2E territory — they belong to the
      // Playwright suite + the route-gating smoke layer, not unit coverage —
      // so they're deliberately out of this denominator.
      include: ["src/lib/**/*.ts", "src/app/actions/**/*.ts", "src/app/api/**/*.ts"],
      // Generated/infra boundary wrappers that aren't meaningfully unit-
      // testable (Prisma/Supabase/SDK clients, type-only files).
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/lib/prisma.ts",
        "src/lib/inngest/client.ts",
        "src/lib/stripe/types.ts",
        // Browser-only live-caption plumbing: a LiveKit Room subscription and
        // localStorage inside React effects — not meaningfully unit-testable in
        // node, the same boundary as the call .tsx components. Both files are
        // deliberately thin wrappers; every decision they make lives in
        // caption-feed.ts and preferences.ts, which are pure and tested.
        // Keep in lockstep with scripts/diff-coverage.mjs EXCLUDE.
        "src/lib/captions/use-caption-feed.ts",
        "src/lib/captions/use-caption-preferences.ts",
      ],
      // `json` (coverage-final.json, per-line hit counts) feeds the
      // diff-coverage gate (scripts/diff-coverage.mjs); summary/html are for
      // humans.
      reporter: ["text-summary", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
      // Regression floor, re-baselined 2026-09-06 for coverage-v8 5. ~1.5pt
      // under the measured level (81.22% lines, 79.89% statements, 80.76%
      // functions, 68.11% branches).
      //
      // ⚠️ BRANCHES MOVED DOWN, AND IT IS NOT A LOST TEST. coverage-v8 5 remaps
      // through the AST instead of counting the transpiled output, so every
      // denominator changed on an unaltered tree. Measured back to back, same
      // include/exclude, same commit:
      //
      //   statements  79.96% (40145/50203)  →  79.89% (14358/17971)
      //   branches    83.21% ( 9712/11671)  →  68.11% ( 9887/14516)
      //   functions   85.40% ( 1831/ 2144)  →  80.76% ( 2448/ 3031)
      //   lines       79.96% (40145/50203)  →  81.22% (12999/16004)
      //
      // The branch DENOMINATOR grew 24% (11,671 → 14,516) while covered
      // branches rose 1.8%. The provider did not stop counting covered
      // branches; it started counting ~2,800 real ones the old output-based
      // walk never saw, and they are mostly uncovered. So the honest reading is
      // that branch coverage was never 83% — that number was measured against a
      // denominator missing a fifth of the branches. Lines and statements are
      // the same figure from the other side: ~50k "statements" was transpiled
      // duplication, not source.
      //
      // Which is why "ratchet upward only" is not being broken here even though
      // one number falls: the two floors are not measurements of the same
      // thing. Three of the four go UP (lines 72 → 79, statements 72 → 78,
      // functions held at 79 against a harder denominator). Never lower one of
      // these again without a measurement of this shape beside it.
      //
      // The previous floor (63/73/71) was set 2026-06-26 against a then-measured
      // 64.5/74.8/72.3, and coverage grew ~9pt on lines without the floor
      // following it — which meant a change could have deleted nine points of
      // real coverage and still passed. A floor that trails the truth that far
      // is decoration, so re-ratchet it whenever an audit measures a gap, not
      // only when adding tests.
      //
      // The per-PR diff-coverage gate (scripts/diff-coverage.mjs), not this
      // aggregate floor, is what holds NEW code to account.
      thresholds: {
        lines: 79,
        functions: 79,
        branches: 66,
        statements: 78,
      },
    },
  },
  resolve: { alias: sharedAlias },
});
