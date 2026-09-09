import { describe, expect, it } from "vitest";
import { buildPoolConfig, POOL_CONNECTION_TIMEOUT_MS, POOL_MAX } from "@/lib/db-pool";

// These assertions were written against `buildPooledDatabaseUrl`, which encoded
// the pool in the connection string because that is how Prisma 6 read it. The
// Prisma 7 driver adapter takes real pg pool options instead, so the same
// properties are asserted against their new home — the point of each was never
// the query string.
describe("buildPoolConfig", () => {
  it("sets a pool larger than 1, since production is a long-lived Fly process serving concurrent requests", () => {
    expect(buildPoolConfig("postgres://user:pass@host/db").max).toBeGreaterThan(1);
    expect(POOL_MAX).toBeGreaterThan(1);
  });

  it("keeps a fail-fast connection timeout, in MILLISECONDS", () => {
    // `pool_timeout=10` meant ten SECONDS. pg's option is milliseconds, so the
    // straight copy of the number would have been a 10ms timeout — every query
    // failing under the least contention, looking exactly like a dead database.
    expect(buildPoolConfig("postgres://user:pass@host/db").connectionTimeoutMillis).toBe(10_000);
    expect(POOL_CONNECTION_TIMEOUT_MS).toBe(10_000);
  });

  it("strips the Prisma-only parameters that pg cannot interpret", () => {
    const { connectionString } = buildPoolConfig(
      "postgres://user:pass@host/db?connection_limit=1&pool_timeout=2&pgbouncer=true",
    );
    expect(connectionString).toBe("postgres://user:pass@host/db");
  });

  it("preserves the parameters pg DOES read, and the base connection string", () => {
    const { connectionString } = buildPoolConfig(
      "postgres://user:pass@host/db?sslmode=require&pgbouncer=true",
    );
    expect(connectionString!.startsWith("postgres://user:pass@host/db?")).toBe(true);
    const params = new URL(connectionString!).searchParams;
    expect(params.get("sslmode")).toBe("require");
    expect(params.get("pgbouncer")).toBeNull();
  });
});
