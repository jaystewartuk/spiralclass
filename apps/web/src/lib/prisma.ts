import { PrismaClient } from "@prisma/client";

import { pgAdapter } from "@/lib/db-pool";

// Singleton to survive Next.js dev HMR.
//
// This is THE database client for every path — request handlers, server
// actions, migrations, seeds, webhooks, Inngest jobs. There is no separate
// RLS-enforced client anymore: the Supabase Auth/RLS stack was retired in the
// Neon migration (the old `@/lib/supabase/server` client is gone). That means
// there is NO database-level tenancy backstop — every tenant-scoped query MUST
// carry an explicit `where: { teacherId }` (or equivalent), because nothing
// downstream will filter for you. Enforce tenancy at the call site + through
// the auth gates (requireOnboardedTeacher / requireApiTeacher / etc.).
declare global {
  var __prisma: PrismaClient | undefined;
}

function buildPrismaClient(): PrismaClient {
  const log: ["error", "warn"] | ["error"] =
    process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

  // Prisma 7 removed `url` from the schema, so there is no longer a path by
  // which the client finds the database on its own: EVERY environment goes
  // through the adapter now, not just production as it did before.
  //
  // ⚠️ CONSTRUCTING MUST NOT REQUIRE THE URL TO EXIST, which is why this
  // tolerates an absent DATABASE_URL rather than throwing. Under Prisma 6 the
  // URL lived in the schema and `new PrismaClient()` neither read it nor
  // connected, so importing this module cost nothing — and 65 unit-test files
  // import it transitively, with no database in sight. A throw here takes the
  // whole unit suite with it. `PrismaPg` likewise only stores its config; the
  // pool connects on first query.
  //
  // Nothing is being swallowed: DATABASE_URL is a REQUIRED field of the server
  // env schema in lib/env.ts, so an environment that genuinely lacks it fails
  // there, at boot, with a better message than a database client could give.
  return new PrismaClient({ log, adapter: pgAdapter(process.env.DATABASE_URL ?? "") });
}

export const prisma = globalThis.__prisma ?? buildPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
