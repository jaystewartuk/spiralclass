import { describe, expect, it } from "vitest";
import { getIntegrationRegistry } from "@/lib/economics/registry";

// D-86 S3 — the Integration registry read side. Exercised against a fake
// Prisma client (mirrors economics-seed-registry.test.ts's fakePrisma
// pattern) rather than a real DB.

function fakePrisma(rows: any[]) {
  return {
    integration: {
      findMany: async ({ where }: any) => {
        if (!where) return rows;
        return rows.filter((r) => r.active === where.active);
      },
    },
  } as any;
}

function row(over: any = {}) {
  return {
    id: "id-1",
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    currency: "USD",
    pricingModel: { kind: "free" },
    active: true,
    sortOrder: 0,
    ...over,
  };
}

describe("getIntegrationRegistry", () => {
  it("Zod-parses the pricingModel column and maps every field through", async () => {
    const [entry] = await getIntegrationRegistry(fakePrisma([row()]));
    expect(entry).toEqual({
      id: "id-1",
      key: "vercel",
      name: "Vercel",
      category: "hosting",
      currency: "USD",
      pricingModel: { kind: "free" },
      active: true,
      sortOrder: 0,
    });
  });

  it("fails soft to pricingModel: null for unparseable JSON, without throwing", async () => {
    const [entry] = await getIntegrationRegistry(
      fakePrisma([row({ pricingModel: { kind: "not_a_real_kind" } })]),
    );
    expect(entry.pricingModel).toBeNull();
  });

  it("falls back to the default category for an unrecognized stored value", async () => {
    const [entry] = await getIntegrationRegistry(
      fakePrisma([row({ category: "not_a_real_category" })]),
    );
    expect(entry.category).toBe("other");
  });

  it("defaults to active-only", async () => {
    const rows = [row({ key: "a", active: true }), row({ key: "b", active: false })];
    const entries = await getIntegrationRegistry(fakePrisma(rows));
    expect(entries.map((e) => e.key)).toEqual(["a"]);
  });

  it("includes inactive rows when activeOnly: false", async () => {
    const rows = [row({ key: "a", active: true }), row({ key: "b", active: false })];
    const entries = await getIntegrationRegistry(fakePrisma(rows), { activeOnly: false });
    expect(entries.map((e) => e.key).sort()).toEqual(["a", "b"]);
  });
});
