import type { DiscountRejectReason } from ".";

// What the teacher's dashboard needs to KNOW about a discount code, as opposed
// to what the checkout needs to DECIDE about one (./index.ts).
//
// The two must never disagree, and they used to. The dashboard's whole status
// model was the `active` column, so a code that had expired, or had burned
// through `maxRedemptions`, rendered exactly like a working one — no badge, no
// warning, nothing. The teacher shared it, the student got "That code has
// expired" at checkout, and the only screen that could have told her said the
// code was fine.
//
// So the state machine here is DERIVED FROM the checkout's rejection order
// rather than invented alongside it: resolveAndValidateDiscount() tests
// inactive, then expired, then the total cap, and returns the first that hits.
// `discountState` walks the same three tests in the same order, which is what
// makes "what the dashboard shows" and "what the student is told" the same
// sentence. `REJECTION_FOR_STATE` pins that correspondence in the type system
// so a future reason added to one side has to be answered on the other.

/**
 * A code's state from the teacher's point of view.
 *
 * `live` is the only one a student can redeem. The other three are all "not
 * redeemable", but they are not interchangeable: `paused` is something she did
 * and can undo, while `expired` and `usedUp` are facts about the world that
 * flipping `active` will not change — which is why the row offers a Resume
 * button for one and not the others.
 */
export const DISCOUNT_STATES = ["live", "paused", "expired", "usedUp"] as const;
export type DiscountState = (typeof DISCOUNT_STATES)[number];

/**
 * The checkout rejection each non-live state produces, so the dashboard's
 * badge and the student's error are provably the same event. `per_student` and
 * `not_found` have no dashboard state on purpose: both depend on WHICH student
 * is asking, and this screen has no student.
 */
export const REJECTION_FOR_STATE: Record<
  Exclude<DiscountState, "live">,
  Extract<DiscountRejectReason, "inactive" | "expired" | "max_redemptions">
> = {
  paused: "inactive",
  expired: "expired",
  usedUp: "max_redemptions",
};

/** The fields a state decision reads. Deliberately not the Prisma row. */
export type DiscountCodeFacts = {
  active: boolean;
  /** End-of-day UTC of the chosen date — see createDiscountCode. */
  expiresAt: Date | null;
  /** null = unlimited. */
  maxRedemptions: number | null;
  /** Redemptions whose purchase is still live; a refund frees the use. */
  usedCount: number;
};

/**
 * Which of the four states a code is in.
 *
 * The order of the tests is load-bearing and is the checkout's order, not a
 * preference: a code that is both paused and expired reads as `paused`,
 * because that is the reason a student would actually be given.
 */
export function discountState(code: DiscountCodeFacts, now: Date): DiscountState {
  if (!code.active) return "paused";
  if (code.expiresAt && code.expiresAt <= now) return "expired";
  if (code.maxRedemptions != null && code.usedCount >= code.maxRedemptions) return "usedUp";
  return "live";
}

/** How many redemptions remain before the cap. `null` when uncapped. */
export function usesLeft(
  code: Pick<DiscountCodeFacts, "maxRedemptions" | "usedCount">,
): number | null {
  if (code.maxRedemptions == null) return null;
  return Math.max(0, code.maxRedemptions - code.usedCount);
}

/**
 * The instant a `YYYY-MM-DD` expiry actually takes effect: the end of that day,
 * UTC.
 *
 * One definition, used by the writer (createDiscountCode), the validator (the
 * create action's not-in-the-past check) and the reader (daysUntilExpiry).
 * The literal used to live only inside the writer, which meant every other
 * place that wanted to reason about expiry had to re-derive the convention and
 * could quietly pick a different one.
 */
export function expiryInstant(ymd: string): Date {
  return new Date(`${ymd}T23:59:59.999Z`);
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `now` until the code stops working, on the UTC calendar the
 * expiry was stored against — 0 means "today is the last day", and `null`
 * means either no expiry or one already past.
 *
 * UTC and not the teacher's zone, because the date she picked is what was
 * stored: a `<input type="date">` yields an unzoned `YYYY-MM-DD`, and
 * createDiscountCode pins it to 23:59:59.999Z of that day. Reading it back on
 * the same calendar is what makes the date she typed the date she sees.
 */
export function daysUntilExpiry(expiresAt: Date | null, now: Date): number | null {
  if (!expiresAt || expiresAt <= now) return null;
  const startOfExpiryDay = Date.UTC(
    expiresAt.getUTCFullYear(),
    expiresAt.getUTCMonth(),
    expiresAt.getUTCDate(),
  );
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((startOfExpiryDay - startOfToday) / MS_PER_DAY));
}

/**
 * How close to the end a live code has to be before the row says so.
 *
 * A week for time and three uses for the cap — far enough out that she can act
 * (extend the promo, tell people it is closing) and near enough that the
 * warning is not permanent furniture on every code she owns.
 */
export const EXPIRING_SOON_DAYS = 7;
export const RUNNING_OUT_USES = 3;

/** The one thing worth flagging on an otherwise-live code, or nothing. */
export type DiscountUrgency =
  { kind: "expiring"; days: number } | { kind: "runningOut"; left: number } | null;

/**
 * Whichever end the code will reach FIRST, or null.
 *
 * One warning, not two: a code that is both nearly out of uses and nearly out
 * of days would otherwise wear a pair of amber badges saying the same thing
 * twice, and the row's job is to say what to do about it once.
 */
export function discountUrgency(
  code: DiscountCodeFacts,
  now: Date,
  state: DiscountState = discountState(code, now),
): DiscountUrgency {
  if (state !== "live") return null;
  const left = usesLeft(code);
  const days = daysUntilExpiry(code.expiresAt, now);
  const runningOut = left != null && left <= RUNNING_OUT_USES;
  const expiring = days != null && days <= EXPIRING_SOON_DAYS;
  // Both ends in sight: the cap wins, because it can be reached this afternoon
  // by people who already have the code, while a date arrives on a schedule.
  if (runningOut) return { kind: "runningOut", left: left as number };
  if (expiring) return { kind: "expiring", days: days as number };
  return null;
}

// ---------------------------------------------------------------------------
// What the codes have actually done
// ---------------------------------------------------------------------------

/**
 * One live redemption, flattened from Prisma.
 *
 * `paid*` is null until the payment settles: the manual-transfer rail creates
 * the package the moment the student commits, so counting an unconfirmed
 * transfer as revenue would report money that has not arrived.
 */
export type RedemptionFact = {
  discountCodeId: string;
  /** What the discount took off, in `currency`. */
  amountMinorUnits: number;
  currency: string;
  /** What the student actually paid, once the payment is `paid`. */
  paidMinorUnits: number | null;
  paidCurrency: string | null;
};

export type CodeTotals = {
  used: number;
  /** Sum of the discounts given, in the code's own currency. */
  givenMinorUnits: number;
  /** Sum of the settled payments those redemptions belong to. */
  salesMinorUnits: number;
};

export const NO_TOTALS: CodeTotals = { used: 0, givenMinorUnits: 0, salesMinorUnits: 0 };

/** Per-code totals, keyed by `discountCodeId`. Codes with no redemptions are absent. */
export function totalsByCode(rows: readonly RedemptionFact[]): Map<string, CodeTotals> {
  const out = new Map<string, CodeTotals>();
  for (const row of rows) {
    const acc = out.get(row.discountCodeId) ?? { ...NO_TOTALS };
    acc.used += 1;
    acc.givenMinorUnits += row.amountMinorUnits;
    // Only when the payment settled AND it settled in the same currency the
    // discount was denominated in. Adding a GBP sale to an MXN discount would
    // produce a number that is not money in any currency.
    if (row.paidMinorUnits != null && row.paidCurrency === row.currency) {
      acc.salesMinorUnits += row.paidMinorUnits;
    }
    out.set(row.discountCodeId, acc);
  }
  return out;
}

export type CurrencyTotal = { currency: string } & Omit<CodeTotals, "used">;

/**
 * The page-level roll-up: one entry per currency, biggest discount first.
 *
 * Per currency rather than one grand total because there is no exchange rate
 * in this codebase and inventing one to make a prettier tile would be lying
 * about her money. In practice a teacher's pricing currency is chosen once at
 * onboarding, so this is a one-element array — but it degrades into two honest
 * lines rather than one wrong number if that ever stops being true.
 */
export function totalsByCurrency(rows: readonly RedemptionFact[]): CurrencyTotal[] {
  const out = new Map<string, CurrencyTotal>();
  for (const row of rows) {
    const acc = out.get(row.currency) ?? {
      currency: row.currency,
      givenMinorUnits: 0,
      salesMinorUnits: 0,
    };
    acc.givenMinorUnits += row.amountMinorUnits;
    if (row.paidMinorUnits != null && row.paidCurrency === row.currency) {
      acc.salesMinorUnits += row.paidMinorUnits;
    }
    out.set(row.currency, acc);
  }
  return [...out.values()].sort((a, b) => b.givenMinorUnits - a.givenMinorUnits);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Live codes first, then the rest, each half newest-first.
 *
 * The list was strictly newest-first, which is the wrong sort for a promo:
 * codes accumulate, so the ones she is running now sink under last summer's as
 * soon as she makes anything newer. Within a half, creation order is kept —
 * it is the only ordering she has any memory of.
 */
export function compareForList<T extends { state: DiscountState; createdAt: Date }>(
  a: T,
  b: T,
): number {
  const aLive = a.state === "live" ? 0 : 1;
  const bLive = b.state === "live" ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive;
  return b.createdAt.getTime() - a.createdAt.getTime();
}
