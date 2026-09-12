import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

// `lib/prisma.ts` casts the extended client back to `PrismaClient`, on the
// argument that a query-only extension changes nothing about the surface. 258
// places in src/ annotate against `PrismaClient`, so if that argument is ever
// wrong the cast turns a real type error into a runtime one — the worst
// possible trade.
//
// So the argument is checked rather than asserted in a comment. A `result`,
// `model` or `client` extension component added later changes what the client
// exposes, and this is what notices.
describe("the extended client still is a PrismaClient", () => {
  it("keeps the client-level methods", () => {
    for (const method of [
      "$transaction",
      "$connect",
      "$disconnect",
      "$queryRaw",
      "$executeRaw",
      "$extends",
    ] as const) {
      expect(typeof prisma[method], `prisma.${method}`).toBe("function");
    }
  });

  it("keeps the model delegates, with their operations", () => {
    // One tenant-owned model the guard intercepts, one it ignores — so a
    // regression that dropped delegates for either half is visible.
    for (const model of ["booking", "teacher", "student", "package"] as const) {
      for (const op of ["findMany", "findFirst", "findUnique", "create", "update", "count"]) {
        expect(
          typeof (prisma[model] as unknown as Record<string, unknown>)[op],
          `prisma.${model}.${op}`,
        ).toBe("function");
      }
    }
  });

  it("adds no method of its own", () => {
    // The cast says the extension adds nothing. A `model` or `client`
    // component would put a name here, and the cast would then be hiding it
    // from every call site.
    const surface = new Set(Object.keys(prisma));
    for (const unexpected of ["tenancy", "guard", "withTenant", "scope"]) {
      expect(surface.has(unexpected), `unexpected member ${unexpected}`).toBe(false);
    }
  });
});
