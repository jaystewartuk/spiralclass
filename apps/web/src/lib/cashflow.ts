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
//
// EVERY MONTH IS THE TEACHER'S MONTH, AND A LESSON BELONGS TO THE MONTH IT WAS
// TAUGHT. Both halves were once wrong. Months were cut in UTC, so for a teacher
// in Mexico City every class ending after 6pm on the last day of a month was
// filed under the next one — "this month" reset on the evening of the 30th,
// straight after her last class of September, and the September total she
// wanted to close the month on was nowhere on screen. And a lesson was dated by
// `completedAt`, which is when the auto-complete sweep (or a teacher's manual
// override, possibly days later) flipped its status, not when it was taught.
// So a lesson is dated by `scheduledStart` and filed by `monthKey()` in her
// timezone — the same rule the payments ledger already used for money received.

import { currencyForTeacher, FALLBACK_TIMEZONE } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { monthKey, monthsBetween, shiftMonthKey } from "@/lib/payments-list";

// How many months of earnings history a teacher sees, the current one
// included. A year is the span she compares across, and it bounds the one
// query that feeds it.
export const EARNINGS_HISTORY_MONTHS = 12;

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
  // When the class was taught — its `scheduledStart` — NOT `completedAt`, which
  // is when the status flipped (see the header).
  taughtAt: Date;
  pricePerLessonMinorUnits: number;
  // The currency of the package this lesson was sold under — the same per-row
  // stamp `CashFlowPackage.currency` carries, and what keeps a lesson in the
  // right slice when a teacher has sold in two.
  currency: string;
};

// What one calendar month of teaching earned, in one currency.
export type MonthEarnings = {
  // `YYYY-MM` on the teacher's calendar.
  month: string;
  earnedCents: number;
  lessons: number;
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
  // The month before this one, closed. What she reads on the 1st, when "this
  // month" has just reset to nothing, to see what the month she finished made.
  previousMonthEarnedCents: number;
  previousMonthLessons: number;
  // Every month from her first taught month (or `EARNINGS_HISTORY_MONTHS`
  // back, whichever is later) through the current one, NEWEST FIRST, with a
  // month she taught nothing in present as a zero rather than missing — a gap
  // in the list would hide exactly the month she most needs to see. Empty for a
  // teacher who has never taught a class. `months[0]` is the current month.
  months: MonthEarnings[];
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
  // The IANA zone whose calendar months every monthly figure is cut on: the
  // teacher's own. Required rather than defaulted to UTC, because UTC is the
  // default that filed her evening classes under the wrong month.
  timeZone: string;
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
  // Completed lessons covering at least the last `EARNINGS_HISTORY_MONTHS` of
  // her calendar through now. Anything older is ignored, so over-fetching is
  // harmless and under-fetching is not.
  completedLessons: CompletedLesson[],
  // When her first completed lesson was taught, or null if she's never
  // delivered one. Decides warm-up vs steady state and where history begins.
  firstDeliveredAt: Date | null,
  now: Date,
  { fallbackCurrency, preferCurrency, timeZone }: SummarizeOptions,
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
        timeZone,
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
  timeZone: string,
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

  // Every month below is a `YYYY-MM` key on HER calendar, never a UTC instant.
  const currentMonth = monthKey(now, timeZone);
  const firstMonth = firstDeliveredAt === null ? null : monthKey(firstDeliveredAt, timeZone);

  // How many calendar months of history exist, inclusive of both the first
  // delivered month and the current one (same month → 1).
  const monthsElapsed = firstMonth === null ? 0 : monthsBetween(firstMonth, currentMonth) + 1;

  // Revenue and lesson count per month, summed unrounded — a per-lesson price
  // is the package price over its class count and need not be whole — and
  // rounded once per month below.
  const byMonth = new Map<string, { revenue: number; lessons: number }>();
  for (const l of completedLessons) {
    const key = monthKey(l.taughtAt, timeZone);
    const month = byMonth.get(key) ?? { revenue: 0, lessons: 0 };
    month.revenue += l.pricePerLessonMinorUnits;
    month.lessons += 1;
    byMonth.set(key, month);
  }
  const revenueIn = (key: string) => byMonth.get(key)?.revenue ?? 0;

  const historyLength = Math.min(monthsElapsed, EARNINGS_HISTORY_MONTHS);
  const months: MonthEarnings[] = [];
  for (let back = 0; back < historyLength; back++) {
    const key = shiftMonthKey(currentMonth, -back);
    const month = byMonth.get(key);
    months.push({
      month: key,
      earnedCents: Math.round(month?.revenue ?? 0),
      lessons: month?.lessons ?? 0,
    });
  }
  const previousMonth = byMonth.get(shiftMonthKey(currentMonth, -1));

  let safeMonthlySpendCents = 0;
  let provisionalMonths = 0;

  if (monthsElapsed >= 4) {
    // Steady state: clean trailing-3-full-month average. The current partial
    // month is excluded so a slow first week doesn't deflate the figure.
    const revenue = [1, 2, 3].reduce(
      (sum, back) => sum + revenueIn(shiftMonthKey(currentMonth, -back)),
      0,
    );
    safeMonthlySpendCents = Math.round(revenue / 3);
  } else if (monthsElapsed >= 1) {
    // Warm-up: fewer than 3 full months of history. Include the current partial
    // month and divide by the months she's actually been delivering, so the
    // number is non-zero from week one. Shown as provisional until it settles.
    let revenue = 0;
    for (let back = 0; back < monthsElapsed; back++) {
      revenue += revenueIn(shiftMonthKey(currentMonth, -back));
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
    currentMonthEarnedCents: Math.round(revenueIn(currentMonth)),
    currentMonthLessons: byMonth.get(currentMonth)?.lessons ?? 0,
    previousMonthEarnedCents: Math.round(previousMonth?.revenue ?? 0),
    previousMonthLessons: previousMonth?.lessons ?? 0,
    months,
  };
}

// Prisma-bound wrapper: fetch the inputs for one teacher, then summarize.
export async function computeTeacherCashFlow(
  teacherId: string,
  now: Date = new Date(),
): Promise<CashFlow> {
  // The history window, cut in UTC and one month wider than it needs to be:
  // her zone is not known until the parallel read below returns, and no zone
  // is more than a day from UTC, so a whole spare month covers every one of
  // them. The pure function files each lesson on her calendar and drops the
  // overhang.
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - EARNINGS_HISTORY_MONTHS, 1),
  );

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
    // Completed lessons taught in the window (through now), with their package
    // price and currency — the price to derive per-lesson revenue, the
    // currency to file it under the right slice. Served by the
    // (teacher_id, scheduled_start) index.
    prisma.booking.findMany({
      where: {
        teacherId,
        status: "completed",
        scheduledStart: { gte: windowStart, lte: now },
      },
      select: {
        scheduledStart: true,
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
      where: { teacherId, status: "completed" },
      orderBy: { scheduledStart: "asc" },
      select: { scheduledStart: true },
    }),
    // Her configured pricing currency — which slice to lead with, and the
    // answer for a teacher with no packages at all — and her timezone, whose
    // calendar every month is cut on. Looked up here rather than taken as
    // arguments so the call sites (payments page, dashboard) stay one line.
    prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { pricingCurrency: true, timezone: true },
    }),
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
    .filter((b) => b.package.classesTotal > 0)
    .map((b) => ({
      taughtAt: b.scheduledStart,
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
    firstDelivered?.scheduledStart ?? null,
    now,
    {
      fallbackCurrency: configured,
      preferCurrency: configured,
      // Same reasoning as the currency fallback above: a vanished row is not
      // worth crashing over, and UTC cannot be mistaken for a resolved zone.
      timeZone: teacher?.timezone ?? FALLBACK_TIMEZONE,
    },
  );
}
