import type { Prisma, PrismaClient } from "@prisma/client";
import { priceForMethod } from "@/lib/payments/instruments";

// Grandfathering, per package. ONE resolver, because the old flat column
// was read in six places and displayed in four, and the display and the charge
// disagreeing is the whole failure this replaces: the portal rendered a price
// the checkout did not charge.
//
// A missing entry means "no agreed price for this package" — the catalog price
// applies. That is the difference from the flat column, which could not say
// which package it meant and so applied to all of them.
//
// ONE STUDENT ROW, always the one the purchase is charged through
// (`purchasingLinkFor`). There was briefly a second, identity-wide resolver
// here for the display side, and it recreated the display-vs-charge split
// above in a new place: the portal quoted an agreed price found on a sibling
// student row while checkout, reading the pairing row alone, charged the
// catalog price. Resolve prices for a row, never for an identity.

export type GrandfatheredPrices = ReadonlyMap<string, number>;

export const NO_GRANDFATHERED_PRICES: GrandfatheredPrices = new Map();

type Db = PrismaClient | Prisma.TransactionClient;

/** Every agreed price this student has with this teacher, keyed by template id. */
export async function grandfatheredPricesFor(
  db: Db,
  teacherId: string,
  studentId: string,
): Promise<GrandfatheredPrices> {
  const rows = await db.teacherStudentTemplatePrice.findMany({
    where: { teacherId, studentId },
    select: { templateId: true, priceMinorUnits: true },
  });
  return new Map(rows.map((r) => [r.templateId, r.priceMinorUnits]));
}

type PricedTemplate = {
  id: string;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
};

/**
 * What this student pays for this package, on this rail.
 *
 * An agreed price wins over the catalog price on BOTH rails — there is no
 * grandfathered transfer price, so the rail only matters when no agreed price
 * exists. Same call the flat column made.
 */
export function effectivePriceMinorUnits(
  prices: GrandfatheredPrices,
  template: PricedTemplate,
  method: "stripe" | "manual_transfer",
): number {
  const agreed = prices.get(template.id);
  return agreed ?? priceForMethod(template, method);
}
