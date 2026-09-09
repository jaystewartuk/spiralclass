import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { Prisma } from "@prisma/client";

// The page's JSX compiles to the classic runtime under vitest's esbuild, and
// nothing here renders it — the queries have all been issued by the time the
// element tree is built. Same shim as tests/settings/payments-page-structure.
(globalThis as Record<string, unknown>).React = React;

// /admin/teachers — pins the QUERY SHAPE, against the schema itself.
//
// The page 500'd in production from D-113 until 2026-09-06 on a `where` that
// filtered `teacher.wiseApiProfileId`, a column D-113 had moved onto the
// payout INSTRUMENT, and its `select` still asked the instrument for
// `schemeId`/`details`, which D-145 dropped. Both are runtime-only failures:
// Prisma's `Subset` types accept an unknown key inside a spread `where`
// literal, and an inline nested `select` is not excess-property-checked
// either, so `tsc --noEmit` passes on both (verified — that is why the gate
// was green while the page was down).
//
// So this test validates every `where` and `select` the page issues against
// `Prisma.dmmf`, which IS the schema. A column that moves or is dropped fails
// here even when nothing else in the repo notices.

type PrismaCall = { model: string; method: string; args: Record<string, unknown> };
const calls: PrismaCall[] = [];

function record(model: string, method: string) {
  return (args: Record<string, unknown> = {}) => {
    calls.push({ model, method, args });
    return Promise.resolve(method === "count" ? 0 : []);
  };
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      count: record("Teacher", "count"),
      findMany: record("Teacher", "findMany"),
    },
  },
}));

vi.mock("@/lib/admin", () => ({
  requireAdmin: async () => ({ role: "support" }),
  getAdminEmails: async () => ["admin@spiralclass.com"],
}));
vi.mock("@/lib/i18n", () => ({ getT: async () => (k: string) => k }));
// The table is a client component; nothing here renders it.
vi.mock("@/app/admin/teachers/teachers-table", () => ({ TeachersTable: () => null }));

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

// Filter/aggregate keys that are Prisma's own, not the model's.
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);

function fieldOf(model: string, name: string) {
  return MODELS.get(model)?.fields.find((f) => f.name === name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every key of `where` must be a real field of `model` (or a logical
// operator). Relation filters recurse into the related model, so a stale
// column one level down is caught too.
function unknownWhereKeys(model: string, where: unknown, path = "where"): string[] {
  if (!isPlainObject(where)) return [];
  const bad: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (LOGICAL.has(key)) {
      const branches = Array.isArray(value) ? value : [value];
      branches.forEach((b, i) => bad.push(...unknownWhereKeys(model, b, `${path}.${key}[${i}]`)));
      continue;
    }
    const field = fieldOf(model, key);
    if (!field) {
      bad.push(`${path}.${key}`);
      continue;
    }
    if (field.kind !== "object" || !isPlainObject(value)) continue;
    for (const [op, nested] of Object.entries(value)) {
      const next = RELATION_FILTERS.has(op) ? nested : value;
      const nextPath = RELATION_FILTERS.has(op) ? `${path}.${key}.${op}` : `${path}.${key}`;
      bad.push(...unknownWhereKeys(field.type, next, nextPath));
      if (!RELATION_FILTERS.has(op)) break;
    }
  }
  return bad;
}

// Same, for `select` — including the nested relation selects and `_count`.
function unknownSelectKeys(model: string, select: unknown, path = "select"): string[] {
  if (!isPlainObject(select)) return [];
  const bad: string[] = [];
  for (const [key, value] of Object.entries(select)) {
    if (key === "_count") {
      const inner = isPlainObject(value) ? value.select : undefined;
      for (const relation of Object.keys(isPlainObject(inner) ? inner : {})) {
        if (!fieldOf(model, relation)) bad.push(`${path}._count.select.${relation}`);
      }
      continue;
    }
    const field = fieldOf(model, key);
    if (!field) {
      bad.push(`${path}.${key}`);
      continue;
    }
    if (field.kind === "object" && isPlainObject(value)) {
      bad.push(...unknownSelectKeys(field.type, value.select, `${path}.${key}.select`));
    }
  }
  return bad;
}

let pageFn: (a: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
beforeAll(async () => {
  pageFn = (await import("@/app/admin/teachers/page")).default;
});

beforeEach(() => {
  calls.length = 0;
});

async function renderWith(params: Record<string, string> = {}) {
  await pageFn({ searchParams: Promise.resolve(params) });
  return calls;
}

describe("/admin/teachers query shape", () => {
  it("names only columns the schema actually has, in every where and select", async () => {
    // The `stalled` filter builds the widest `where` the page can produce.
    const cases: Record<string, string>[] = [
      {},
      { q: "ana", onboarded: "yes", disabled: "no", stalled: "yes" },
    ];
    for (const params of cases) {
      const issued = await renderWith(params);
      expect(issued.length).toBeGreaterThan(0);
      for (const call of issued) {
        expect(unknownWhereKeys(call.model, call.args.where)).toEqual([]);
        expect(unknownSelectKeys(call.model, call.args.select)).toEqual([]);
      }
      calls.length = 0;
    }
  });

  it("counts Wise-connected teachers through the instrument relation, not a teacher column", async () => {
    const issued = await renderWith();
    const wiseCount = issued.find(
      (c) =>
        c.method === "count" &&
        isPlainObject(c.args.where) &&
        "payoutInstruments" in (c.args.where as Record<string, unknown>),
    );
    expect(wiseCount, "no count filtered on the payoutInstruments relation").toBeTruthy();
    expect(wiseCount!.args.where).toMatchObject({
      payoutInstruments: { some: { kind: "wise", wiseApiProfileId: { not: null } } },
    });
    // And the admin-list exclusion still applies to it — the stat counts the
    // same population the table below shows.
    expect(wiseCount!.args.where).toMatchObject({ email: { notIn: ["admin@spiralclass.com"] } });
  });

  it("selects the instrument columns the table's badges read", async () => {
    const issued = await renderWith();
    const list = issued.find((c) => c.method === "findMany");
    const select = (list!.args.select as Record<string, unknown>).payoutInstruments;
    expect((select as { select: Record<string, unknown> }).select).toEqual({
      kind: true,
      enabled: true,
      wiseHandle: true,
      wiseApiProfileId: true,
    });
  });
});
