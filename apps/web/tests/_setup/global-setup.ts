/**
 * Vitest globalSetup for the `integration` project. Runs once per
 * test process (before any test file loads).
 *
 *   - TEST_DATABASE_URL missing → log + return. The integration suites
 *     all wrap in `describeIntegration(...)` (in test-db.ts) which
 *     skips when the env var is missing, so the run completes green
 *     with zero work done.
 *
 *   - TEST_DATABASE_URL present → apply pending Prisma migrations once
 *     against the test DB so every integration test starts against
 *     the current schema.
 *
 * Self-contained: must NOT import from `vitest` (or transitively from
 * any file that does) — Vitest's globalSetup runs in a different
 * context and erroring loudly when it sees the test runtime imports.
 */

import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.warn(
      "[integration:global-setup] TEST_DATABASE_URL not set — integration suites will skip.",
    );
    return;
  }
  // CI runs migrate in its own step before invoking vitest; it sets
  // SKIP_GLOBAL_MIGRATE=1 so the global-setup doesn't re-shell into
  // prisma. Local docker-compose runs leave it unset, so the
  // global-setup is responsible for the first migrate.
  if (process.env.SKIP_GLOBAL_MIGRATE === "1") {
    // eslint-disable-next-line no-console
    console.log(
      "[integration:global-setup] SKIP_GLOBAL_MIGRATE=1 — assuming migrations pre-applied.",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[integration:global-setup] applying migrations against TEST_DATABASE_URL");
  try {
    execSync("pnpm prisma migrate deploy", {
      cwd: process.cwd(),
      // Prisma reads `directUrl` from the schema for migrate; the
      // job/process-level DIRECT_URL stub would short-circuit the
      // connect. Pin both to the test DB.
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: "inherit",
    });
  } catch (err) {
    // execSync throws an Error with status, signal, output as
    // properties — log them explicitly so failures aren't opaque
    // (the default serialization swallows useful detail).
    // eslint-disable-next-line no-console
    console.error(
      "[integration:global-setup] migrate failed:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}
