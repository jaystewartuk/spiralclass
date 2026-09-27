// Packages for two (D-188). A package can be bought once, by one buyer, for two
// people who take every class together — a couple, two siblings. The pair is
// one student account, one package and one booking per class; what "for two"
// changes is the price, the credit pool it spends from, and a consent note.
//
// These are the rules the booking page, the buy flow, the package editor and
// checkout all have to agree on, so they live here rather than at each call
// site. A group class (three or more, each attendee her own account) is D-149's
// model and not this one.

import { currencyExponent } from "./money";

/** How many people take each class on a package. */
export type Seats = 1 | 2;

export const SEATS: readonly Seats[] = [1, 2];

/**
 * What two people pay by default, as a percent of the one-person price: the
 * second person pays half. A teacher changes it per account, and it only ever
 * SUGGESTS a price in the editor — every two-person price is stored on its
 * template, so a charge is always a number the teacher saw.
 */
export const DEFAULT_TWO_PERSON_PRICE_PERCENT = 150;
/** Below 100% the second person would make the class cheaper than one. */
export const MIN_TWO_PERSON_PRICE_PERCENT = 100;
/** Past 300% it is a typo, not a price. Mirrors the database CHECK. */
export const MAX_TWO_PERSON_PRICE_PERCENT = 300;

/**
 * Read a seat count from an untrusted value (a form field, a query string).
 * Anything that is not exactly two people is one person — the default every
 * surface already sells — so a missing or garbled value can never quietly
 * turn a purchase into a dearer one.
 */
export function parseSeats(value: unknown): Seats {
  return value === 2 || value === "2" ? 2 : 1;
}

/** Is this percent one a teacher may save? Whole numbers within the range. */
export function isValidTwoPersonPricePercent(percent: number): boolean {
  return (
    Number.isInteger(percent) &&
    percent >= MIN_TWO_PERSON_PRICE_PERCENT &&
    percent <= MAX_TWO_PERSON_PRICE_PERCENT
  );
}

/**
 * The two-person price the editor suggests for a one-person price, rounded to a
 * whole major unit of the teacher's own currency — so 1,850 MXN at 150% is
 * 2,775, and a 0-decimal currency never grows a phantom fraction.
 */
export function suggestTwoPersonPrice(
  priceMinorUnits: number,
  percent: number,
  currency: string,
): number {
  if (priceMinorUnits <= 0) return 0;
  const step = 10 ** currencyExponent(currency);
  return Math.round((priceMinorUnits * percent) / 100 / step) * step;
}

/** The price columns a template carries, on both rails and both seat counts. */
export type SeatPricedTemplate = {
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  twoPersonPriceMinorUnits: number | null;
  twoPersonTransferPriceMinorUnits: number | null;
};

/** Is this template sold for two at all? */
export function offersTwoPerson(
  tpl: Pick<SeatPricedTemplate, "twoPersonPriceMinorUnits">,
): boolean {
  return tpl.twoPersonPriceMinorUnits !== null;
}

/**
 * The catalog price of a template for a seat count, on a rail — or null when
 * the template is not sold for that many people.
 *
 * The non-card price falls back to the card price for the same seat count,
 * never across seat counts: a two-person package with no transfer price of its
 * own costs the two-person price by transfer, not the one-person transfer
 * price.
 */
export function priceForSeats(
  tpl: SeatPricedTemplate,
  seats: Seats,
  method: "stripe" | "manual_transfer",
): number | null {
  if (seats === 1) {
    return method === "manual_transfer"
      ? (tpl.transferPriceMinorUnits ?? tpl.priceMinorUnits)
      : tpl.priceMinorUnits;
  }
  if (tpl.twoPersonPriceMinorUnits === null) return null;
  return method === "manual_transfer"
    ? (tpl.twoPersonTransferPriceMinorUnits ?? tpl.twoPersonPriceMinorUnits)
    : tpl.twoPersonPriceMinorUnits;
}

/**
 * What one person pays for one class — the figure a couple actually compares
 * against a solo package. Null when there is nothing to divide.
 */
export function perPersonPerClassMinorUnits(
  totalMinorUnits: number,
  classCount: number,
  seats: Seats,
): number | null {
  if (totalMinorUnits <= 0 || !Number.isInteger(classCount) || classCount < 1) return null;
  return Math.round(totalMinorUnits / (classCount * seats));
}
