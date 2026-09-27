import type { Prisma, PrismaClient } from "@prisma/client";
import { priceForSeats, type Seats } from "@spiralclass/shared";

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
  twoPersonPriceMinorUnits: number | null;
  twoPersonTransferPriceMinorUnits: number | null;
};

/**
 * What this student pays for this package, on this rail, for this many people
 * — or null when the template is not sold for that many.
 *
 * An agreed price wins over the catalog price on BOTH rails — there is no
 * grandfathered transfer price, so the rail only matters when no agreed price
 * exists. Same call the flat column made.
 *
 * An agreed price is a price for ONE person (D-188): it was agreed for the
 * package as she has always bought it, so it never prices the package bought
 * for two. A student held at an old one-person rate who buys for two pays the
 * two-person catalog price.
 */
export function effectivePriceMinorUnits(
  prices: GrandfatheredPrices,
  template: PricedTemplate,
  method: "stripe" | "manual_transfer",
  seats: Seats = 1,
): number | null {
  const agreed = seats === 1 ? prices.get(template.id) : undefined;
  return agreed ?? priceForSeats(template, seats, method);
}
