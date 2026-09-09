// A package template gets asked two different questions, and until D-144's
// follow-up one boolean — `singleClass` — was answering both of them.
//
//   1. "Is this ONE class?"  A fact about the offering's SHAPE. It decides the
//      per-class arithmetic, which templates can compete for the "best value"
//      badge, and how the duration is worded on the booking page.
//
//   2. "Does paying RESERVE the slot?"  A fact about how it is SOLD. It decides
//      whether checkout refuses to take money until a time is chosen
//      (pay-at-reservation, D-111) and whether the first-class picker sits
//      above the pay button or below it.
//
// Those coincide for every template a teacher sets up deliberately, which is
// why one flag carried both for so long. They come apart in exactly one state:
//
//   classCount === 1 && singleClass === false
//
// — one class, sold as a credit the student books later. It is reachable from
// the templates form by setting Classes to 1 and leaving "Sell as an individual
// class" unticked, it is a legitimate thing to sell, and the live Mexican
// teacher was in it: a template named "Individual class" that priced like a
// single class and checked out like a package. She has since ticked the box,
// but the ambiguity that let it happen silently is the thing being fixed here.
//
// The old code split on question 1 in the pricing maths (`singleClass ||
// classCount === 1`) and on question 2 everywhere else, including the two
// places that were really asking question 1. Naming both predicates makes each
// call site state which question it means, so the next divergence is a visible
// choice rather than a coin flip.

/** The fields either predicate needs. Structural, so a Prisma row, a wire type
 *  or a test fixture all satisfy it without adapters. */
export type ClassOfferingShape = {
  singleClass: boolean;
  classCount: number;
};

/**
 * Question 1 — is this offering a single class?
 *
 * True for a template explicitly sold as an individual class, AND for any
 * template of exactly one class however it is sold: one class is one class, and
 * its per-class price is the single-class rate whether the student reserves it
 * now or banks it for later. Using the flag alone here would let a one-class
 * credit compete for "best value" against itself.
 */
export function isOneClassOffering(tpl: ClassOfferingShape): boolean {
  return tpl.singleClass || tpl.classCount === 1;
}

/**
 * Question 2 — does paying for this reserve the slot?
 *
 * ONLY the explicit flag. A one-class credit (classCount 1, flag unticked) is
 * deliberately NOT included: the student buys it and books later, so demanding
 * a time before checkout would make it unbuyable whenever the teacher's
 * availability window happens to be empty. That is a real cost, and it is the
 * teacher's call to opt into, not something inferred from the class count.
 *
 * Kept as a named function rather than reading `.singleClass` at the call site
 * so the two questions cannot drift back together unnoticed.
 */
export function reservesSlotAtPurchase(tpl: ClassOfferingShape): boolean {
  return tpl.singleClass;
}

/**
 * The state where the two questions disagree — one class, sold as a credit.
 *
 * Not an error. The templates form uses it to explain, at the moment the
 * teacher creates it, what her students will actually get, because the setting
 * that produces it is an unticked box rather than anything she chose.
 */
export function isOneClassSoldAsCredit(tpl: ClassOfferingShape): boolean {
  return isOneClassOffering(tpl) && !reservesSlotAtPurchase(tpl);
}
