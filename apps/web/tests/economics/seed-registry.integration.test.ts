import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { KNOWN_INTEGRATIONS } from "@spiralclass/shared";
import { ensureIntegrationsSeeded } from "@/lib/economics/seed-registry";

// D-86 S2 — the create-if-absent Integration registry seed against a real
// Postgres, verifying the unique `key` index + createMany/skipDuplicates
// contract this file relies on to never clobber an admin's edited row
// (tests/lib/economics-seed-registry.test.ts covers the same behaviour
// against a fake Prisma for the fast unit run).
describeIntegration("ensureIntegrationsSeeded", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("inserts every KNOWN_INTEGRATIONS row into an empty registry", async () => {
    const prisma = getTestPrisma();
    const count = await ensureIntegrationsSeeded(prisma);

    expect(count).toBe(KNOWN_INTEGRATIONS.length);
    expect(await prisma.integration.count()).toBe(KNOWN_INTEGRATIONS.length);

    const vercel = await prisma.integration.findUniqueOrThrow({ where: { key: "vercel" } });
    expect(vercel.name).toBe("Vercel");
    expect(vercel.category).toBe("hosting");
    expect(vercel.currency).toBe("USD");
    expect(vercel.pricingModel).toEqual({ kind: "free" });
    expect(vercel.active).toBe(true);
  });

  it("running it twice never duplicates or overwrites an edited row", async () => {
    const prisma = getTestPrisma();
    await ensureIntegrationsSeeded(prisma);

    // Simulate an admin editing a seeded row's pricing + deactivating it.
    await prisma.integration.update({
      where: { key: "vercel" },
      data: {
        pricingModel: { kind: "monthly", amountMinor: 2000, currency: "USD" },
        active: false,
      },
    });

    const secondRunCount = await ensureIntegrationsSeeded(prisma);

    expect(secondRunCount).toBe(0);
    expect(await prisma.integration.count()).toBe(KNOWN_INTEGRATIONS.length);
    const vercel = await prisma.integration.findUniqueOrThrow({ where: { key: "vercel" } });
    expect(vercel.active).toBe(false);
    expect(vercel.pricingModel).toEqual({ kind: "monthly", amountMinor: 2000, currency: "USD" });
  });

  it("fills in only newly-added keys when the registry already has some rows", async () => {
    const prisma = getTestPrisma();
    const first = KNOWN_INTEGRATIONS[0];
    await prisma.integration.create({
      data: {
        key: first.key,
        name: first.name,
        category: first.category,
        pricingModel: first.pricingModel,
        currency: first.currency,
      },
    });

    const count = await ensureIntegrationsSeeded(prisma);

    expect(count).toBe(KNOWN_INTEGRATIONS.length - 1);
    expect(await prisma.integration.count()).toBe(KNOWN_INTEGRATIONS.length);
  });
});
