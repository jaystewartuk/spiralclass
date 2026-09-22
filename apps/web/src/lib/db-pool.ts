import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

// How every Prisma client in the repo reaches Postgres, since Prisma 7.
//
// It lives in its own module rather than in `lib/prisma.ts` because that file
// constructs the app singleton at import time: a script or test that wanted
// only the pool settings would trip that side effect, and the two callers that
// need a DIFFERENT database (the seed's DIRECT_URL, the integration suite's
// TEST_DATABASE_URL) would have opened the app's connection just by importing.

// Production runs on Fly (D-70/D-89): one long-lived Node process per machine
// serves many concurrent requests through a single shared Prisma client,
// unlike a Vercel function (one connection per invocation). A pool of 1 there
// would serialize every concurrent query in the process — including
// /api/health's own SELECT 1 — behind whichever request already holds the lone
// connection, which is what caused "DB health check timed out after 5000ms" in
// production (Sentry SPIRALCLASS-21). Size the pool for real in-process
// concurrency; the connection timeout still makes the client fail fast (503)
// rather than hang when the pool is genuinely exhausted.
export const POOL_MAX = 10;
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

// Prisma-engine-only query parameters. Until Prisma 7 these WERE the pooling
// configuration: the client read `connection_limit`, `pool_timeout` and
// `pgbouncer` off the connection string itself. The pg driver understands none
// of them, so they are stripped here and re-expressed as real pool options —
// stripped rather than ignored, because one left behind in a deployed
// DATABASE_URL should not travel into the driver as a mystery parameter.
const PRISMA_ONLY_URL_PARAMS = ["connection_limit", "pool_timeout", "pgbouncer", "schema"];

/**
 * The pg pool the driver adapter runs on.
 *
 * ⚠️ THIS REPLACES THE QUERY-STRING POOLING OF PRISMA 6, and the numbers are
 * carried across deliberately rather than re-chosen: `max` is the old
 * `connection_limit=10`, and `connectionTimeoutMillis` is the old
 * `pool_timeout=10`, which was expressed in SECONDS — hence the ×1000. Getting
 * that unit wrong would have turned a 10-second fail-fast into a 10-millisecond
 * one, which reads as the database being down under any load at all.
 *
 * The third parameter, `pgbouncer=true`, has no pg equivalent and needs none.
 * It told Prisma's engine to stop issuing NAMED prepared statements, which a
 * transaction-mode pooler cannot keep across checkouts. node-postgres only uses
 * a named prepared statement when a query carries a `name`, and the adapter
 * never sets one — so what that flag bought is simply the default here.
 * Connections still go through Neon's pooled (pgbouncer) endpoint, so this
 * bounds the client-side pool, not raw Postgres backends.
 */
export function buildPoolConfig(databaseUrl: string): PoolConfig {
  const [base, qs = ""] = databaseUrl.split("?");
  const params = new URLSearchParams(qs);
  for (const key of PRISMA_ONLY_URL_PARAMS) params.delete(key);
  const rest = params.toString();

  return {
    connectionString: rest ? `${base}?${rest}` : base,
    max: POOL_MAX,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  };
}

/** The driver adapter to hand `new PrismaClient({ adapter })`. */
export function pgAdapter(databaseUrl: string): PrismaPg {
  return new PrismaPg(buildPoolConfig(databaseUrl));
}

/**
 * The adapter for `DATABASE_URL` — what `datasource.url` used to mean, and what
 * every operational script (backfills, cleanups, the importer) got for free
 * from a bare `new PrismaClient()` before Prisma 7.
 */
export function envAdapter(): PrismaPg {
  return pgAdapter(process.env.DATABASE_URL ?? "");
}
