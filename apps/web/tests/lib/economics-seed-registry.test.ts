import { describe, expect, it } from "vitest";
import { KNOWN_INTEGRATIONS } from "@spiralclass/shared";
import {
  ensureIntegrationsSeeded,
  refreshDefaultIntegrations,
} from "@/lib/economics/seed-registry";

// D-86 S2 — the create-if-absent seed for the Integration registry. Uses a
// fake Prisma `integration.createMany` that mimics the real unique-`key`
// `skipDuplicates` semantics (mirrors tests/wise/credentials.test.ts's
// fakePrisma pattern) rather than a real DB — the createMany/skipDuplicates
// contract itself is Prisma's, not this file's, to verify.
function fakePrisma(existingKeys: string[] = []) {
  const rows: any[] = existingKeys.map((key) => ({ key }));
  return {
    rows,
    prisma: {
      integration: {
        createMany: async ({ data, skipDuplicates }: any) => {
          const existing = new Set(rows.map((r) => r.key));
          let count = 0;
          for (const row of data) {
            if (skipDuplicates && existing.has(row.key)) continue;
            rows.push(row);
            existing.add(row.key);
            count++;
          }
          return { count };
        },
      },
    } as any,
  };
}

describe("ensureIntegrationsSeeded", () => {
  it("inserts every KNOWN_INTEGRATIONS row on an empty registry", async () => {
    const { rows, prisma } = fakePrisma();
    const count = await ensureIntegrationsSeeded(prisma);

    expect(count).toBe(KNOWN_INTEGRATIONS.length);
    expect(rows.map((r) => r.key).sort()).toEqual(KNOWN_INTEGRATIONS.map((i) => i.key).sort());
  });

  it("carries pricingModel, currency, category, and sortOrder through untouched", async () => {
    const { rows, prisma } = fakePrisma();
    await ensureIntegrationsSeeded(prisma);

    const vercel = rows.find((r) => r.key === "vercel");
    const knownVercel = KNOWN_INTEGRATIONS.find((i) => i.key === "vercel")!;
    expect(vercel.pricingModel).toEqual(knownVercel.pricingModel);
    expect(vercel.currency).toBe(knownVercel.currency);
    expect(vercel.category).toBe(knownVercel.category);
    expect(vercel.sortOrder).toBe(KNOWN_INTEGRATIONS.findIndex((i) => i.key === "vercel"));
  });

  it("is a no-op for a key that already exists — never clobbers an admin edit", async () => {
    const { rows, prisma } = fakePrisma(["vercel"]);
    const before = rows.find((r) => r.key === "vercel");

    const count = await ensureIntegrationsSeeded(prisma);

    expect(count).toBe(KNOWN_INTEGRATIONS.length - 1);
    // The existing row object is untouched (still the pre-seed placeholder,
    // not overwritten with the KNOWN_INTEGRATIONS defaults).
    expect(rows.find((r) => r.key === "vercel")).toBe(before);
    expect(rows.filter((r) => r.key === "vercel")).toHaveLength(1);
  });

  it("is idempotent across repeated calls", async () => {
    const { rows, prisma } = fakePrisma();
    await ensureIntegrationsSeeded(prisma);
    const secondRunCount = await ensureIntegrationsSeeded(prisma);

    expect(secondRunCount).toBe(0);
    expect(rows).toHaveLength(KNOWN_INTEGRATIONS.length);
  });
});

// Fake supporting the create/update/findMany path refreshDefaultIntegrations
// uses. Rows carry createdAt/updatedAt so the "un-edited = updatedAt equals
// createdAt" guard is exercised; update() bumps updatedAt like @updatedAt does.
function refreshFake(rows: any[] = []) {
  return {
    rows,
    prisma: {
      integration: {
        findMany: async () =>
          rows.map((r) => ({ key: r.key, createdAt: r.createdAt, updatedAt: r.updatedAt })),
        create: async ({ data }: any) => {
          const now = new Date("2026-07-19T00:00:00.000Z");
          const row = { ...data, createdAt: now, updatedAt: now };
          rows.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = rows.find((r) => r.key === where.key);
          Object.assign(row, data);
          row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
          return row;
        },
      },
    } as any,
  };
}

// A registry row as if freshly inserted (never edited): updatedAt == createdAt.
function unedited(key: string, overrides: Record<string, unknown> = {}) {
  const t = new Date("2026-01-01T00:00:00.000Z");
  return { key, createdAt: t, updatedAt: t, ...overrides };
}
// An admin-edited row: updatedAt strictly after createdAt.
function edited(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("refreshDefaultIntegrations", () => {
  it("creates every row on an empty registry", async () => {
    const { rows, prisma } = refreshFake();
    const result = await refreshDefaultIntegrations(prisma);

    expect(result).toEqual({ created: KNOWN_INTEGRATIONS.length, refreshed: 0, skipped: 0 });
    expect(rows).toHaveLength(KNOWN_INTEGRATIONS.length);
  });

  it("refreshes an UN-EDITED row to the current defaults", async () => {
    // vercel present but with a stale pricing model, never edited.
    const { rows, prisma } = refreshFake([
      unedited("vercel", { pricingModel: { kind: "monthly", amountMinor: 999, currency: "USD" } }),
    ]);

    const result = await refreshDefaultIntegrations(prisma);

    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.created).toBe(KNOWN_INTEGRATIONS.length - 1);
    const known = KNOWN_INTEGRATIONS.find((i) => i.key === "vercel")!;
    expect(rows.find((r) => r.key === "vercel")!.pricingModel).toEqual(known.pricingModel);
  });

  it("NEVER clobbers an admin-edited row", async () => {
    const custom = { kind: "monthly", amountMinor: 4242, currency: "GBP" };
    const { rows, prisma } = refreshFake([edited("vercel", { pricingModel: custom })]);

    const result = await refreshDefaultIntegrations(prisma);

    expect(result.skipped).toBe(1);
    expect(result.refreshed).toBe(0);
    // The edited value is preserved exactly.
    expect(rows.find((r) => r.key === "vercel")!.pricingModel).toEqual(custom);
  });
});
