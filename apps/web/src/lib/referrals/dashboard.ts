import { currencyExponent, currencyForTeacher } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// Everything the teacher's /dashboard/referrals screen reads, in one place and
// one round-trip's worth of queries.
//
// Kept separate from ./manage.ts on purpose: that module is the shared
// read/write core, and its `ReferralProgramView` is a wire shape an installed
// client already parses. Widening it to carry a results panel would put fields
// on that wire that no client asked for. This module is free to change.

/** One reward side, in the units the teacher typed them in. */
export type RewardDraft = {
  kind: "percent" | "fixed";
  /** Whole percent (15 = 15%), or null when this side is a fixed amount. */
  percent: number | null;
  /** Major units of her pricing currency, or null when this side is percent. */
  amount: number | null;
};

/** How a referral is doing, in the teacher's terms rather than the schema's. */
export type ReferralActivityStatus = "awaiting" | "rewarded" | "void";

export type ReferralActivityRow = {
  id: string;
  /** The student who shared the link. Null only if the row was orphaned. */
  referrerName: string | null;
  friendName: string | null;
  status: ReferralActivityStatus;
  /** What the friend saved, in centavos of `currency`. */
  discountMinorUnits: number;
  currency: string;
  createdAt: Date;
};

export type ReferralDashboard = {
  /** Null when she has never opened this screen and saved. */
  configured: boolean;
  enabled: boolean;
  referred: RewardDraft;
  referrer: RewardDraft;
  rewardExpiryDays: number | null;
  /** Her own pricing currency — what both reward amounts are denominated in. */
  currency: string;
  /**
   * The package a referred friend is most likely to buy, used to make the
   * live preview her numbers rather than a made-up example. The CHEAPEST
   * unarchived template, because the referred discount only ever applies to a
   * friend's FIRST package and the entry offer is what a newcomer buys. Null
   * when she has no templates at all.
   */
  samplePackage: { name: string; priceMinorUnits: number; currency: string } | null;
  stats: {
    /** Students holding a share link. The leading indicator: it moves before
     * any money does, and a zero here means the program is on but nobody has
     * opened their portal since. */
    sharers: number;
    /** Friends who bought through a link and have not been refunded. */
    friends: number;
    /** Referrals that have paid out a reward code to the referrer. */
    rewarded: number;
    /** What those friends actually paid her, in `currency`. */
    revenueMinorUnits: number;
    /** What the friends' side of the program cost her, in `currency`. */
    discountMinorUnits: number;
  };
  activity: ReferralActivityRow[];
};

const ACTIVITY_LIMIT = 8;

function draft(
  kind: "percent" | "fixed" | null | undefined,
  percentBps: number | null | undefined,
  amountMinorUnits: number | null | undefined,
  exponentDivisor: number,
): RewardDraft {
  return {
    kind: (kind ?? "fixed") as "percent" | "fixed",
    percent: percentBps ? percentBps / 100 : null,
    amount: amountMinorUnits ? amountMinorUnits / exponentDivisor : null,
  };
}

export async function getReferralDashboard(teacher: {
  id: string;
  pricingCurrency?: string | null;
}): Promise<ReferralDashboard> {
  const currency = currencyForTeacher(teacher);

  const [program, sharers, referrals, sampleTemplate] = await Promise.all([
    prisma.referralProgram.findUnique({ where: { teacherId: teacher.id } }),
    prisma.referralCode.count({ where: { teacherId: teacher.id, active: true } }),
    prisma.referral.findMany({
      where: { teacherId: teacher.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        referredDiscountMinorUnits: true,
        currency: true,
        createdAt: true,
        referredStudent: { select: { name: true } },
        referralCode: { select: { owner: { select: { name: true } } } },
        payment: { select: { amountMinorUnits: true, currency: true, paidAt: true } },
      },
    }),
    prisma.packageTemplate.findFirst({
      // `gt: 0` because a free template prices every reward at zero and the
      // breakdown would confidently report that a referral costs nothing.
      where: { teacherId: teacher.id, archived: false, priceMinorUnits: { gt: 0 } },
      orderBy: { priceMinorUnits: "asc" },
      select: { name: true, priceMinorUnits: true, currency: true },
    }),
  ]);

  // A voided referral is one whose purchase was refunded — the friend is not a
  // customer and the money is not hers, so it counts in neither the totals nor
  // the revenue. It stays in the activity list, because a teacher who sees a
  // referral vanish assumes the product lost it.
  const live = referrals.filter((r) => r.status !== "void");

  return {
    configured: program != null,
    enabled: program?.enabled ?? false,
    // The stored amounts are minor units of the currency they were saved in;
    // dividing by 100 here would be wrong for a 0-decimal currency. The
    // program's own `currency` column is the one they were written against.
    referred: draft(
      program?.referredKind,
      program?.referredPercentBps,
      program?.referredAmountMinorUnits,
      minorUnitDivisor(program?.currency ?? currency),
    ),
    referrer: draft(
      program?.referrerKind,
      program?.referrerPercentBps,
      program?.referrerAmountMinorUnits,
      minorUnitDivisor(program?.currency ?? currency),
    ),
    rewardExpiryDays: program?.rewardExpiryDays ?? null,
    currency,
    samplePackage: sampleTemplate
      ? {
          name: sampleTemplate.name,
          priceMinorUnits: sampleTemplate.priceMinorUnits,
          currency: sampleTemplate.currency,
        }
      : null,
    stats: {
      sharers,
      friends: live.length,
      rewarded: referrals.filter((r) => r.status === "rewarded").length,
      revenueMinorUnits: live.reduce(
        (sum, r) => sum + (r.payment?.paidAt ? r.payment.amountMinorUnits : 0),
        0,
      ),
      discountMinorUnits: live.reduce((sum, r) => sum + r.referredDiscountMinorUnits, 0),
    },
    activity: referrals.slice(0, ACTIVITY_LIMIT).map((r) => ({
      id: r.id,
      referrerName: r.referralCode?.owner?.name ?? null,
      friendName: r.referredStudent?.name ?? null,
      status: activityStatus(r.status),
      discountMinorUnits: r.referredDiscountMinorUnits,
      currency: r.currency,
      createdAt: r.createdAt,
    })),
  };
}

// Four schema states collapse to three the teacher can act on. `attributed`
// (bought, not settled) and `qualified` (settled, reward mid-flight) are the
// same sentence to her — "we're waiting" — and distinguishing them would name
// an Inngest step in her dashboard.
function activityStatus(status: string): ReferralActivityStatus {
  if (status === "rewarded") return "rewarded";
  if (status === "void") return "void";
  return "awaiting";
}

// The stored column is minor units; the form edits major units. The divisor is
// the currency's own exponent, NOT a hardcoded 100 — a 0-decimal currency
// (JPY, CLP, KRW, VND) read back through /100 renders a hundredth of what the
// teacher saved, and saving that form again would store it.
function minorUnitDivisor(currency: string): number {
  return 10 ** currencyExponent(currency);
}
