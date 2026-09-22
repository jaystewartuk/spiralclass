import { PrismaClient } from "@prisma/client";

import { pgAdapter } from "@/lib/db-pool";
import { tenancyGuardExtension } from "@/lib/tenancy/guard";

// Singleton to survive Next.js dev HMR.
//
// This is THE database client for every path — request handlers, server
// actions, migrations, seeds, webhooks, Inngest jobs. There is no separate
// RLS-enforced client anymore: the Supabase Auth/RLS stack was retired in the
// Neon migration (the old `@/lib/supabase/server` client is gone). That means
// there is still NO database-level tenancy backstop — every tenant-scoped query MUST
// carry an explicit `where: { teacherId }` (or equivalent), because nothing
// downstream will filter for you. Enforce tenancy at the call site + through
// the auth gates (requireOnboardedTeacher / requireApiTeacher / etc.).
//
// Two things now check that rather than trusting it, and neither is a database
// policy: `scripts/tenancy-guard.mjs` reads the source before the push (D-175),
// and the extension below reads the arguments as the query runs (D-176). Both
// are application-level. The reversal to real RLS is tracked in Issues.
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
  const client = new PrismaClient({ log, adapter: pgAdapter(process.env.DATABASE_URL ?? "") });

  // The tenancy guard (D-176). It compares each query's arguments against the
  // tenant the auth gate said this request is for, and it is the only thing in
  // the repository that can see a `where` assembled at runtime — the static
  // scanner reads source and cannot.
  //
  // ⚠️ THE CAST IS LOAD-BEARING AND IT IS SOUND. `$extends` returns a branded
  // client type, and 258 places in `src/` annotate against `PrismaClient`
  // itself (`type Db = PrismaClient | Prisma.TransactionClient` and friends) —
  // handing them the branded type is a 258-error typecheck for no behavioural
  // difference. This extension declares ONLY a `query` component: it adds no
  // method, removes none, and changes no argument or return type, so the
  // runtime surface is `PrismaClient` exactly. `tests/tenancy/client-surface.test.ts`
  // asserts that surface on the extended client rather than trusting the
  // sentence — a `result`, `model` or `client` component added here later WOULD
  // change it, and the cast would then be hiding a real error.
  return client.$extends(tenancyGuardExtension()) as unknown as PrismaClient;
}

export const prisma = globalThis.__prisma ?? buildPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
