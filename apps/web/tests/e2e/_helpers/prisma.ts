import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Use a dedicated PrismaClient rather than importing the app's
// `@/lib/prisma` wrapper. Playwright's CJS-mode test loader can't
// resolve the ESM `import` syntax inside src/lib/prisma.ts and throws
// `SyntaxError: Cannot use import statement outside a module` at runtime.
// For the same reason every helper in this module imports `@prisma/client`
// directly and NEVER reaches into `@/lib/*`.
//
// Which is why the adapter is built here by hand instead of through
// `@/lib/db-pool`'s `envAdapter()`, and why this file was the LAST thing to
// break in the Prisma 7 upgrade: `new PrismaClient()` used to find the database
// through `datasource.url` in the schema, and Prisma 7 removed that. A bare
// construction is still perfectly well-typed — it fails only at runtime — so
// tsc caught none of it and the browser suite was where it surfaced.
let prismaClient: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prismaClient) {
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
    });
  }
  return prismaClient;
}
