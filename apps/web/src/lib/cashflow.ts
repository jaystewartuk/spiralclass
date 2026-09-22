// Teacher cash-flow ("earned vs held" deferred revenue).
//
// A package is sold and paid up front, but the lessons are delivered over
// weeks or months. So the cash a teacher holds is part *earned* (lessons
// already taught — hers to keep) and part *held* liability (lessons paid for
// but not yet taught — she still owes the work). A sole-income teacher who
// spends to her bank balance over-spends the held portion. This module makes
// that split visible and derives a steadier "safe to spend per month" figure.
//
// Basis is the teacher's actual net (`Payment.teacherNetMinorUnits` — the
// settled Stripe net). There is no marketplace commission in that figure any
// more and no `lib/payments/transfer.ts` to point at: D-143 made her the
// merchant of record, so the only thing between gross and net is STRIPE's own
// processing fee, charged on her own account and never seen by the platform.
// A manual-rail payment carries no processing fee at all, and a card payment
// whose net has not settled yet hasn't recorded one, so both fall back to the
// gross package price (`pricePaidMinorUnits`) — exactly right for the manual
// rail, and a slight over-estimate for the brief pre-settlement card window.
//
// That over-estimate is why `web.cashflow.whyAverage` tells the teacher card
// payments land a little lower after Stripe's fee, and says in the same breath
// that SpiralClass does not receive it (D-152).
//
// EVERY FIGURE IS SCOPED TO ONE CURRENCY. `packages.currency` is stamped per
// package at purchase, so a teacher who changes her pricing currency with paid
// packages on file has rows in two of them, and adding their minor units
// together is meaningless — 20,000 JPY (0-decimal) and £200.00 (2-decimal) are
// both the integer 20000, so the error is not even proportional to an exchange
// rate. There is no FX-rate source in this app and acquiring one for this is
// not proposed, so the answer is the one `lib/money-metrics.ts` already gives
// for mixed-currency subscription revenue: never blend, report per currency.
// `summarizeCashFlow` partitions and returns one exact `CashFlowSummary` per
// currency.

import { currencyForTeacher } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// Only PAID packages carry received cash. `pending` = not yet paid (no cash),
// `refunded` = money returned (reversed). `active`/`paused`/`expired` are the
// statuses a package reaches only after payment confirms.
const PAID_STATUSES = ["active", "paused", "expired"] as const;
type PaidStatus = (typeof PAID_STATUSES)[number];

export type CashFlowPackage = {
  classesTotal: number;
  pricePaidMinorUnits: number;
  // What this package was actually sold in. Recorded per package, not per
  // teacher, because `packages.currency` is stamped at purchase and a teacher
  // who later changes her pricing currency keeps the old rows as they were.
  currency: string;
  status: PaidStatus;
  expiresAt: Date | null;
  // Lessons consumed for good: `completed` + `no_show`. A no-show is forfeited
  // time the teacher earned, so it counts as delivered, not held.
  deliveredLessons: number;
};

export type CompletedLesson = {
  completedAt: Date;
  pricePerLessonMinorUnits: number;
  // The currency of the package this lesson was sold under — the same per-row
  // stamp `CashFlowPackage.currency` carries, and what keeps a lesson in the
  // right slice when a teacher has sold in two.
  currency: string;
};

// One currency's worth of cash flow. Every figure is denominated in `currency`
// and covers only what was sold in it, so the arithmetic is exact rather than
// an addition of unlike minor units.
export type CashFlowSummary = {
  // What every figure below is denominated in.
  //
  // This exists because the renderers had no way to know, and so called
  // `formatMinorUnits(cents)` with no currency — which falls back to MXN. Every
  // cash-flow number on the payments page and the dashboard was printed with a
  // peso symbol regardless of what the teacher actually prices in, so a
  // British teacher's £-denominated earnings read as "$1,500.00 MXN".
  currency: string;
  // Total received cash across all paid packages.
  totalPaidCents: number;
  // Cash for lessons already delivered (incl. forfeited slots) — hers to keep.
  earnedCents: number;
  // Cash for undelivered lessons on still-redeemable packages — still owed.
  heldCents: number;
  // Number of undelivered lessons backing `heldCents`.
  heldLessons: number;
  // Average monthly delivered (completed) revenue — the number to budget
  // living costs on, since it smooths spiky package sales into a steady "this
  // is what you actually earn by teaching each month".
  safeMonthlySpendCents: number;
  // Warm-up signal. 0 = steady state (a clean trailing-3-full-month average).
  // 1–3 = fewer than 3 months of history exist, so the figure is averaged over
  // that many months (current partial month included) and should be shown as
  // provisional. Lets a brand-new teacher see a real number from week one
  // instead of $0 for three months, while it converges to the smooth version.
  provisionalMonths: number;
  // Revenue from lessons actually completed so far *this* calendar month, and
  // how many of them. Shown next to `safeMonthlySpendCents` so the teacher can
  // see why the two differ instead of just distrusting the average — it's not
  // "what you earned this month", it's a 3-month smoothing of that.
  currentMonthEarnedCents: number;
  currentMonthLessons: number;
};

// Cash flow split by the currency it was actually taken in.
export type CashFlow = {
  // The slice to lead with, and the only one most surfaces render.
  primary: CashFlowSummary;
  // Every currency with money in it, `primary` first. **Length 1 for every
  // teacher who has never changed her pricing currency** — which is every
  // teacher today, since a currency is chosen once at onboarding (D-64). The
  // single-currency case therefore stays the simple case, and no surface grows
  // a currency selector for a state nobody is in.
  byCurrency: CashFlowSummary[];
};

type SummarizeOptions = {
  // The denomination when there is no money at all to denominate — a teacher
  // with no paid packages yet.
  fallbackCurrency: string;
  // Lead with this currency when there is money in it. The teacher's currently
  // configured pricing currency: what she sells in now is what her "safe to
  // spend" figure is about, even when an older currency holds more cash.
  // Omitted by the platform roll-up, which has no such thing and leads with the
  // largest pile instead.
  preferCurrency?: string;
};

/**
 * Split cash flow by the currency each package was sold in. Pure — no DB.
 *
 * Currencies come from the packages AND the completed lessons: a lesson can
 * belong to a package that has since been refunded, which keeps it out of
 * `packages` while its delivered revenue still counts toward the monthly
 * average, exactly as it did before the split.
 */
export function summarizeCashFlow(
  packages: CashFlowPackage[],
  // Completed lessons from the start of the 3rd-prior full month through now
  // (the current partial month included — the steady-state path filters it out
  // itself).
  completedLessons: CompletedLesson[],
  // Earliest completed lesson ever, or null if she's never delivered one. Used
  // only to decide warm-up vs steady-state.
  firstDeliveredAt: Date | null,
  now: Date,
  { fallbackCurrency, preferCurrency }: SummarizeOptions,
): CashFlow {
  const currencies = new Set<string>();
  for (const p of packages) currencies.add(p.currency);
  for (const l of completedLessons) currencies.add(l.currency);
  if (currencies.size === 0) currencies.add(fallbackCurrency);

  const slices = [...currencies]
    .map((currency) =>
      summarizeOneCurrency(
        packages.filter((p) => p.currency === currency),
        completedLessons.filter((l) => l.currency === currency),
        // Teacher-wide on purpose, not per slice: this decides warm-up vs
        // steady state, and a teacher four months in is past warm-up in every
        // currency she has ever sold in. Dating each slice from its own first
        // lesson would divide a retired currency's near-zero recent revenue by
        // one or two months and inflate it back into a "safe to spend" figure.
        firstDeliveredAt,
        now,
        currency,
      ),
    )
    .sort((a, b) => b.totalPaidCents - a.totalPaidCents || a.currency.localeCompare(b.currency));

  const preferred = preferCurrency ? slices.find((s) => s.currency === preferCurrency) : undefined;
  // `slices` is never empty — `currencies` holds at least `fallbackCurrency`.
  const primary = preferred ?? slices[0]!;
  return {
    primary,
    byCurrency: preferred ? [preferred, ...slices.filter((s) => s !== preferred)] : slices,
  };
}

/**
 * The earned/held/average arithmetic for ONE currency.
 *
 * ⚠️ Every input must already be denominated in `currency` — this does not
 * filter, it adds. `summarizeCashFlow` above is the entry point that guarantees
 * that; call this directly only with a slice you have partitioned yourself.
 */
export function summarizeOneCurrency(
  packages: CashFlowPackage[],
  completedLessons: CompletedLesson[],
  firstDeliveredAt: Date | null,
  now: Date,
  currency: string,
): CashFlowSummary {
  let totalPaidCents = 0;
  let heldCents = 0;
  let heldLessons = 0;

  for (const p of packages) {
    totalPaidCents += p.pricePaidMinorUnits;
    if (p.classesTotal <= 0) continue;

    // Held applies only to packages that can still be redeemed. An expired (or
    // past-expiry) package can never have its remaining lessons claimed, so
    // that money is fully earned — nothing is owed anymore.
    const redeemable =
      (p.status === "active" || p.status === "paused") &&
      (p.expiresAt === null || p.expiresAt > now);
    if (!redeemable) continue;

    const undelivered = Math.max(0, p.classesTotal - p.deliveredLessons);
    const pricePerLesson = p.pricePaidMinorUnits / p.classesTotal;
    heldCents += Math.round(undelivered * pricePerLesson);
    heldLessons += undelivered;
  }

  // earned = total − held conserves the cents exactly (held is the only
  // rounded term), so earned + held === totalPaid always.
  const earnedCents = totalPaidCents - heldCents;

  // Calendar-month boundaries (UTC). `startOf3PriorFull` opens the steady-state
  // trailing window; `startOfCurrent` is where the current partial month begins.
  const startOf3PriorFull = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const startOfCurrent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // How many calendar months of history exist, inclusive of both the first
  // delivered month and the current one (same month → 1).
  const monthsElapsed =
    firstDeliveredAt === null
      ? 0
      : now.getUTCFullYear() * 12 +
        now.getUTCMonth() -
        (firstDeliveredAt.getUTCFullYear() * 12 + firstDeliveredAt.getUTCMonth()) +
        1;

  let currentMonthEarnedCents = 0;
  let currentMonthLessons = 0;
  for (const l of completedLessons) {
    if (l.completedAt >= startOfCurrent) {
      currentMonthEarnedCents += l.pricePerLessonMinorUnits;
      currentMonthLessons += 1;
    }
  }

  let safeMonthlySpendCents = 0;
  let provisionalMonths = 0;

  if (monthsElapsed >= 4) {
    // Steady state: clean trailing-3-full-month average. The current partial
    // month is excluded so a slow first week doesn't deflate the figure.
    let revenue = 0;
    for (const l of completedLessons) {
      if (l.completedAt >= startOf3PriorFull && l.completedAt < startOfCurrent) {
        revenue += l.pricePerLessonMinorUnits;
      }
    }
    safeMonthlySpendCents = Math.round(revenue / 3);
  } else if (monthsElapsed >= 1) {
    // Warm-up: fewer than 3 full months of history. Include the current partial
    // month and divide by the months she's actually been delivering, so the
    // number is non-zero from week one. Shown as provisional until it settles.
    // (Her first lesson is at most 2 months back here, so every fetched lesson
    // is in range — no extra lower-bound filter needed.)
    let revenue = 0;
    for (const l of completedLessons) {
      revenue += l.pricePerLessonMinorUnits;
    }
    safeMonthlySpendCents = Math.round(revenue / monthsElapsed);
    provisionalMonths = monthsElapsed;
  }

  return {
    currency,
    totalPaidCents,
    earnedCents,
    heldCents,
    heldLessons,
    safeMonthlySpendCents,
    provisionalMonths,
    currentMonthEarnedCents,
    currentMonthLessons,
  };
}

// Prisma-bound wrapper: fetch the inputs for one teacher, then summarize.
export async function computeTeacherCashFlow(
  teacherId: string,
  now: Date = new Date(),
): Promise<CashFlow> {
  // Fetch from the start of the 3rd-prior full month through now — the current
  // partial month is included so warm-up can use it; steady-state filters it
  // out in the pure function.
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));

  const [packages, deliveredGroups, completed, firstDelivered, teacher] = await Promise.all([
    prisma.package.findMany({
      where: { teacherId, status: { in: [...PAID_STATUSES] } },
      select: {
        id: true,
        classesTotal: true,
        pricePaidMinorUnits: true,
        currency: true,
        status: true,
        expiresAt: true,
      },
    }),
    // Lessons delivered (or forfeited) per package, all-time.
    prisma.booking.groupBy({
      by: ["packageId"],
      where: { teacherId, status: { in: ["completed", "no_show"] } },
      _count: { _all: true },
    }),
    // Completed lessons in the trailing window (through now), with their
    // package price and currency — the price to derive per-lesson revenue, the
    // currency to file it under the right slice.
    prisma.booking.findMany({
      where: {
        teacherId,
        status: "completed",
        completedAt: { gte: windowStart, lte: now },
      },
      select: {
        completedAt: true,
        package: {
          select: {
            pricePaidMinorUnits: true,
            classesTotal: true,
            currency: true,
          },
        },
      },
    }),
    // Her very first delivered lesson, ever — decides warm-up vs steady-state.
    prisma.booking.findFirst({
      where: { teacherId, status: "completed", completedAt: { not: null } },
      orderBy: { completedAt: "asc" },
      select: { completedAt: true },
    }),
    // Her configured pricing currency: which slice to lead with, and the
    // answer for a teacher with no packages at all. Looked up here rather than
    // taken as an argument so all three call sites (payments page, dashboard,
    // mobile cashflow route) keep working unchanged.
    prisma.teacher.findUnique({ where: { id: teacherId }, select: { pricingCurrency: true } }),
  ]);

  const deliveredByPkg = new Map(deliveredGroups.map((g) => [g.packageId, g._count._all]));

  const cashPackages: CashFlowPackage[] = packages.map((p) => ({
    classesTotal: p.classesTotal,
    pricePaidMinorUnits: p.pricePaidMinorUnits,
    currency: p.currency,
    status: p.status as PaidStatus,
    expiresAt: p.expiresAt,
    deliveredLessons: deliveredByPkg.get(p.id) ?? 0,
  }));

  const completedLessons: CompletedLesson[] = completed
    .filter((b) => b.completedAt !== null && b.package.classesTotal > 0)
    .map((b) => ({
      completedAt: b.completedAt as Date,
      pricePerLessonMinorUnits: b.package.pricePaidMinorUnits / b.package.classesTotal,
      currency: b.package.currency,
    }));

  // `teacher` is a findUnique on an id we were just handed by an authed
  // caller, so a null here means the row vanished mid-request; fall through to
  // the platform default rather than crashing a money screen over it.
  const configured = currencyForTeacher(teacher ?? {});

  return summarizeCashFlow(
    cashPackages,
    completedLessons,
    firstDelivered?.completedAt ?? null,
    now,
    { fallbackCurrency: configured, preferCurrency: configured },
  );
}
