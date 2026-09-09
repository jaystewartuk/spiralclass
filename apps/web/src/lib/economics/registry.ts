// Financial Intelligence estimate layer (D-86, S3) — the Integration
// registry read side. Fetches rows and Zod-parses each `pricingModel` JSON
// column at the read boundary (fail-soft per the D-86 risk note: an
// unparseable model degrades to `pricingModel: null` — estimate.ts turns
// that into £0 + a warning badge — rather than 500-ing the whole dashboard).

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  parsePricingModel,
  type PricingModel,
  isIntegrationCategory,
  DEFAULT_INTEGRATION_CATEGORY,
  type IntegrationCategory,
} from "@spiralclass/shared";

type Db = PrismaClient | Prisma.TransactionClient;

export type IntegrationRegistryEntry = {
  id: string;
  key: string;
  name: string;
  category: IntegrationCategory;
  currency: string;
  // null when the stored JSON no longer matches pricingModelSchema (fail-soft).
  pricingModel: PricingModel | null;
  active: boolean;
  sortOrder: number;
};

// Every Integration row, active-only by default (what the Overview KPIs and
// cost rollups should sum). Pass `activeOnly: false` for the S4 admin table,
// which needs to show and toggle inactive rows too.
export async function getIntegrationRegistry(
  db: Db = defaultPrisma,
  options: { activeOnly?: boolean } = {},
): Promise<IntegrationRegistryEntry[]> {
  const activeOnly = options.activeOnly ?? true;
  const rows = await db.integration.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    category: isIntegrationCategory(row.category) ? row.category : DEFAULT_INTEGRATION_CATEGORY,
    currency: row.currency,
    pricingModel: parsePricingModel(row.pricingModel),
    active: row.active,
    sortOrder: row.sortOrder,
  }));
}
