import { describe, expect, it } from "vitest";

import { NEGATING_KEYS, TENANT_MODELS, verdictFor } from "@/lib/tenancy/guard";
import { tenantModels } from "../../scripts/tenancy-guard.mjs";

const A = "a1111111-1111-4111-8111-111111111111";
const B = "b2222222-2222-4222-8222-222222222222";

const verdict = (op: string, args: unknown) => verdictFor(op, args, A).kind;

describe("tenancy guard — value check", () => {
  it("passes a query that constrains itself to the tenant being served", () => {
    expect(verdict("findMany", { where: { teacherId: A } })).toBe("matches");
    expect(verdict("findMany", { where: { AND: [{ teacherId: A }, { status: "x" }] } })).toBe(
      "matches",
    );
    expect(verdict("findFirst", { where: { teacher: { id: A } } })).toBe("matches");
    expect(verdict("findMany", { where: { teacherId: { in: [A, B] } } })).toBe("matches");
    expect(verdict("findMany", { where: { teacherId: { equals: A } } })).toBe("matches");
    expect(verdict("update", { where: { id: "x", teacherId: A }, data: {} })).toBe("matches");
    expect(verdict("create", { data: { teacherId: A } })).toBe("matches");
    expect(verdict("create", { data: { teacher: { connect: { id: A } } } })).toBe("matches");
    expect(verdict("upsert", { where: { teacherId: A }, create: {}, update: {} })).toBe("matches");
  });

  it("catches a query that names a different tenant — the leak it exists for", () => {
    // The gap no static check can close: every one of these is a perfectly
    // scoped query. They name a tenant. They just name the wrong one, which is
    // what an id from a URL, a form field or a stale cache looks like.
    expect(verdict("findMany", { where: { teacherId: B } })).toBe("foreign");
    expect(verdict("update", { where: { id: "x", teacherId: B }, data: {} })).toBe("foreign");
    expect(verdict("findFirst", { where: { teacher: { id: B } } })).toBe("foreign");
    expect(verdict("create", { data: { teacherId: B } })).toBe("foreign");
    expect(verdictFor("findMany", { where: { teacherId: B } }, A)).toEqual({
      kind: "foreign",
      named: [B],
    });
  });

  it("does not read a tenant key that constrains nothing as constraining", () => {
    // Prisma treats `undefined` as "no filter" — the decoy the static scanner
    // catches by shape and this one meets carrying a real runtime value.
    expect(verdict("findMany", { where: { teacherId: undefined } })).toBe("none");
    expect(verdict("findMany", { where: { teacherId: null } })).toBe("none");
    // One branch of an OR does not constrain the query, so a match there is
    // not a match — and neither is a mismatch, which is why this is `none` and
    // not `foreign`.
    expect(verdict("findMany", { where: { OR: [{ teacherId: A }, { public: true }] } })).toBe(
      "none",
    );
    expect(verdict("findMany", { where: { NOT: { teacherId: B } } })).toBe("none");
    expect(verdict("findMany", { where: { teacherId: { not: B } } })).toBe("none");
  });

  it("does not credit a tenant key that filters a relation rather than the rows", () => {
    // A `where` under `include`/`select` shapes what comes back with each row.
    // It says nothing about WHICH rows, so finding the tenant there would be a
    // false pass on exactly the query that needs catching.
    expect(verdict("findMany", { include: { bookings: { where: { teacherId: A } } } })).toBe(
      "none",
    );
    expect(verdict("findMany", { where: { status: "x" }, orderBy: { teacherId: "asc" } })).toBe(
      "none",
    );
  });

  it("reports an unconstrained query as unknown rather than as a leak", () => {
    // The ordinary shape of the queries the scanner baselined. Safe or not
    // depending on where their ids came from — a question neither guard can
    // answer, so neither pretends to.
    expect(verdict("findMany", { where: { bookingId: "b1" } })).toBe("none");
    expect(verdict("findMany", {})).toBe("none");
    expect(verdict("findMany", undefined)).toBe("none");
  });

  it("survives arguments that are not the shape it expects", () => {
    // This runs in front of every query on live payment rails. A throw from
    // the inspector itself would be a self-inflicted outage, so the odd shapes
    // are asserted rather than hoped about.
    expect(verdict("findMany", null)).toBe("none");
    expect(verdict("findMany", { where: { teacherId: 42 } })).toBe("none");
    expect(verdict("findMany", { where: { AND: "not-an-array" } })).toBe("none");
    const cyclic: Record<string, unknown> = { where: {} };
    (cyclic.where as Record<string, unknown>).self = cyclic;
    expect(() => verdict("findMany", cyclic)).not.toThrow();
  });
});

describe("tenancy guard — agreement with the static scanner", () => {
  // Two guards that share a vocabulary and drift apart are worse than one:
  // each would report clean on what the other stopped covering. So the overlap
  // is asserted rather than kept in step by hand.
  it("derives the same tenant-owned models the scanner does", () => {
    const fromSchema = tenantModels(); // camelCase client names, read from schema.prisma
    const fromDatamodel = new Set(
      [...TENANT_MODELS].map((m) => m[0].toLowerCase() + m.slice(1)), // dmmf gives PascalCase
    );
    expect(fromDatamodel.size).toBeGreaterThan(50);
    expect([...fromDatamodel].sort()).toEqual([...fromSchema].sort());
  });

  it("treats the same combinators as non-constraining", () => {
    expect([...NEGATING_KEYS].sort()).toEqual(["NOT", "OR", "isNot", "none"].sort());
  });
});
