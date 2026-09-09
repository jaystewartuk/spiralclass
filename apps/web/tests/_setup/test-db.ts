/**
 * Slice 7b — real-DB integration test harness.
 *
 * Usage from a `*.integration.test.ts` file:
 *
 *   import { describeIntegration, getTestPrisma, truncateAll } from "@/tests/_setup/test-db";
 *
 *   describeIntegration("stripe webhook handler", () => {
 *     beforeEach(async () => { await truncateAll(); });
 *
 *     it("flips a payment to paid + activates the package", async () => {
 *       const prisma = getTestPrisma();
 *       // ...seed via prisma, run handler, assert against real rows...
 *     });
 *   });
 *
 * `describeIntegration` skips the whole block when TEST_DATABASE_URL is
 * missing so the integration project no-ops cleanly without the docker
 * container booted.
 */

import { execSync } from "node:child_process";
import { describe } from "vitest";
import { PrismaClient } from "@prisma/client";

import { pgAdapter } from "@/lib/db-pool";

let cachedPrisma: PrismaClient | null = null;

export function hasTestDb(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}

/**
 * Singleton Prisma client pointed at TEST_DATABASE_URL. Reused across
 * the whole test process so migrations + truncations + seeds share a
 * single connection pool.
 *
 * Throws if TEST_DATABASE_URL is missing — wrap callers in
 * `describeIntegration` so they self-skip rather than throw.
 */
export function getTestPrisma(): PrismaClient {
  if (cachedPrisma) return cachedPrisma;
  if (!hasTestDb()) {
    throw new Error(
      "getTestPrisma() called without TEST_DATABASE_URL — wrap the suite in describeIntegration",
    );
  }
  cachedPrisma = new PrismaClient({
    adapter: pgAdapter(process.env.TEST_DATABASE_URL!),
    log: ["warn", "error"],
  });
  return cachedPrisma;
}

/**
 * Apply all pending Prisma migrations against TEST_DATABASE_URL.
 * Idempotent thanks to the `_prisma_migrations` table — re-runs are
 * a no-op once the schema is current. Called once per test process
 * by global-setup.ts.
 */
export function applyMigrations(): void {
  if (!hasTestDb()) return;
  // Use the prisma CLI directly; same code path the main project uses
  // for `prisma migrate deploy`. Pass DATABASE_URL inline so we never
  // touch the production env in this process.
  execSync("pnpm prisma migrate deploy", {
    // Override both DATABASE_URL and DIRECT_URL — Prisma uses
    // directUrl for migrate, and a process-level DIRECT_URL stub
    // (from CI) would short-circuit the connect.
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      DIRECT_URL: process.env.TEST_DATABASE_URL,
    },
    stdio: "inherit",
  });
}

/**
 * TRUNCATE every public-schema table with CASCADE so FK chains reset
 * cleanly. Restarts identity sequences too (so `bookingSeq`-style
 * tests get deterministic ids if they ever rely on them).
 *
 * Faster than dropping + recreating the schema; safe to call between
 * tests. Skips the `_prisma_migrations` table so the migration state
 * survives.
 */
export async function truncateAll(): Promise<void> {
  if (!hasTestDb()) return;
  const prisma = getTestPrisma();
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Wraps a test body in a transaction that always rolls back. Handy
 * when a single test wants to verify a write path without cleaning up
 * after itself + when no other test depends on the row staying.
 */
export async function withTransaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = getTestPrisma();
  let result!: T;
  try {
    await prisma.$transaction(async (tx) => {
      result = await fn(tx as unknown as PrismaClient);
      // Force rollback by throwing a sentinel.
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) throw err;
  }
  return result;
}

class RollbackSentinel extends Error {}

/**
 * Vitest `describe` wrapper that skips when TEST_DATABASE_URL is
 * missing. Logs a one-time warning so a developer running the
 * integration project without the docker container up sees why
 * everything skipped.
 */
let warned = false;
export function describeIntegration(name: string, fn: () => void): void {
  if (!hasTestDb()) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        "[integration] TEST_DATABASE_URL not set — skipping integration suites. " +
          "Boot docker compose -f docker-compose.test.yml up -d and copy .env.test.example.",
      );
      warned = true;
    }
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}
