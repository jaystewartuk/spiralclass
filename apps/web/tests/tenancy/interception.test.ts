import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { runInTeacherScope } from "@/lib/tenancy/context";
import { CrossTenantQueryError } from "@/lib/tenancy/guard";

const A = "a1111111-1111-4111-8111-111111111111";
const B = "b2222222-2222-4222-8222-222222222222";

// Proof that the extension is WIRED, not merely written.
//
// Everything else about this guard can be true while `$allOperations` never
// fires — a misspelt component, a Prisma version that changed the shape, an
// extension applied to a client nothing uses. That failure is silent and looks
// exactly like a clean system, which is the worst property a guard can have.
//
// No database is needed to show it, and that is the trick: the guard throws
// BEFORE it calls through to the query. If it is wired, the error is
// CrossTenantQueryError. If it is not, the call gets as far as trying to
// connect and fails as something else entirely.
describe("the guard actually intercepts queries", () => {
  it("throws on a foreign tenant before the query reaches the database", async () => {
    // The callback is deliberately NOT async and does not await: it hands back
    // an unawaited `PrismaPromise`. That is the shape everyone writes, and it
    // is only guarded because `runInTeacherScope` awaits inside the scope —
    // this test failed with a database connection error until it did. Simplify
    // that helper back to `storage.run(scope, fn)` and this goes red, which is
    // the point of writing it this way round.
    await expect(
      runInTeacherScope(A, () => prisma.booking.findMany({ where: { teacherId: B } })),
    ).rejects.toBeInstanceOf(CrossTenantQueryError);
  });

  it("names the model, the operation and both tenants in the error", async () => {
    const err = await runInTeacherScope(A, () =>
      prisma.package.updateMany({ where: { teacherId: B }, data: {} }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CrossTenantQueryError);
    const cross = err as CrossTenantQueryError;
    expect(cross.model).toBe("Package");
    expect(cross.operation).toBe("updateMany");
    expect(cross.servingTeacherId).toBe(A);
    expect(cross.namedTeacherIds).toEqual([B]);
    // The message has to tell whoever hits this what to do about it.
    expect(cross.message).toContain("runCrossTenant");
  });

  it("lets a correctly scoped query through to the database", async () => {
    // It fails — there is no database in the unit suite — but it must fail as
    // a database problem, never as a tenancy one. This is the assertion that
    // catches a guard which has started refusing everything.
    const err = await runInTeacherScope(A, () =>
      prisma.booking.findMany({ where: { teacherId: A } }),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CrossTenantQueryError);
  });

  it("lets an unconstrained query through — it reports, it does not block", async () => {
    const err = await runInTeacherScope(A, () =>
      prisma.booking.findMany({ where: { status: "scheduled" } }),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CrossTenantQueryError);
  });

  it("ignores a model that carries no tenant column", async () => {
    const err = await runInTeacherScope(A, () =>
      prisma.teacher.findMany({ where: { id: B } }),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CrossTenantQueryError);
  });

  it("does nothing at all with no scope — the state of every path not yet wired", async () => {
    const err = await prisma.booking.findMany({ where: { teacherId: B } }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CrossTenantQueryError);
  });
});
