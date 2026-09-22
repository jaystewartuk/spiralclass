import { defineConfig } from "prisma/config";

/**
 * Prisma 7 moved connection URLs out of schema.prisma. `datasource.url` and
 * `directUrl` are no longer accepted there, so this file is where the CLI —
 * `migrate`, `db execute`, `studio`, `validate` — learns how to reach the
 * database. The APPLICATION no longer reads any of this: since Prisma 7 the
 * runtime connection comes from a driver adapter constructed in
 * `src/lib/prisma.ts`, not from the schema.
 *
 * ⚠️ THIS IS THE UNPOOLED URL, and that is the whole point of the preference
 * order below. It is what `directUrl` meant in the Prisma 6 schema: migrations
 * take advisory locks and run DDL, neither of which survives a pgbouncer
 * transaction-mode pooler, so they must reach Neon's DIRECT endpoint.
 * `DATABASE_URL` is only the fallback for environments that have no separate
 * direct endpoint (local Docker Postgres, the test container) — never a
 * preference.
 *
 * Left UNDEFINED when neither is set, deliberately: `prisma generate` runs from
 * postinstall with no environment at all, and needs no URL. Throwing here would
 * break `pnpm install` on a fresh clone.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
