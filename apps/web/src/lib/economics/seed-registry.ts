import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { KNOWN_INTEGRATIONS } from "@spiralclass/shared";

// Financial Intelligence estimate layer (D-86, S2) — idempotent create-if-
// absent seed of the Integration registry from the shared KNOWN_INTEGRATIONS
// list. Relies on the unique `key` index: `skipDuplicates` makes re-running
// this a no-op for any integration already in the DB and only inserts rows
// added to KNOWN_INTEGRATIONS since the last run (mirrors
// ensureTeacherLevels in src/lib/levels.ts). Deliberately NOT an upsert — an
// upsert would silently overwrite an admin's tuned pricing model, currency,
// or category on every reseed. Rows are numbered by their position in
// KNOWN_INTEGRATIONS so a first seed lands in the same grouped order as the
// source file (hosting, ai, video, …); an admin's own reordering afterwards
// is untouched by later reseeds for the same reason.
type Db = PrismaClient | Prisma.TransactionClient;

function integrationDefaults(integration: (typeof KNOWN_INTEGRATIONS)[number], index: number) {
  return {
    name: integration.name,
    category: integration.category,
    purpose: integration.purpose,
    pricingModel: integration.pricingModel as Prisma.InputJsonValue,
    currency: integration.currency,
    billingModel: integration.billingModel,
    billingUrl: integration.billingUrl,
    docsUrl: integration.docsUrl,
    sortOrder: index,
  };
}

export async function ensureIntegrationsSeeded(db: Db = defaultPrisma): Promise<number> {
  const result = await db.integration.createMany({
    data: KNOWN_INTEGRATIONS.map((integration, index) => ({
      key: integration.key,
      ...integrationDefaults(integration, index),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

// Push the CURRENT KNOWN_INTEGRATIONS defaults onto rows an admin has NOT
// edited — the counterpart to ensureIntegrationsSeeded's create-if-absent path,
// used when the shared defaults are recalibrated (e.g. a pricing refresh) and
// we want them to reach an ALREADY-seeded DB. "Un-edited" = `updatedAt` still
// equals `createdAt`: a fresh insert stamps both with the same transaction
// timestamp, and `@updatedAt` bumps `updatedAt` on any later write, so an
// admin-edited row (or a previously-refreshed one) is left exactly as-is and
// can never be clobbered. Absent rows are created. Note the deliberate
// once-per-row semantic: after a refresh a row looks "edited", so a LATER
// defaults change won't re-propagate to it automatically — rerun intentionally
// or edit via the UI. Safe to call from the (prod-guarded) seed path.
export async function refreshDefaultIntegrations(
  db: Db = defaultPrisma,
): Promise<{ created: number; refreshed: number; skipped: number }> {
  const existing = await db.integration.findMany({
    select: { key: true, createdAt: true, updatedAt: true },
  });
  const byKey = new Map(existing.map((r) => [r.key, r]));

  let created = 0;
  let refreshed = 0;
  let skipped = 0;

  for (const [index, integration] of KNOWN_INTEGRATIONS.entries()) {
    const data = integrationDefaults(integration, index);
    const row = byKey.get(integration.key);
    if (!row) {
      await db.integration.create({ data: { key: integration.key, ...data } });
      created += 1;
    } else if (row.updatedAt.getTime() === row.createdAt.getTime()) {
      await db.integration.update({ where: { key: integration.key }, data });
      refreshed += 1;
    } else {
      skipped += 1;
    }
  }
  return { created, refreshed, skipped };
}
