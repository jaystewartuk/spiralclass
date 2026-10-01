// What a teacher earned, and what she has been paid for but not yet taught.
//
// A package is sold and paid up front, but the lessons are delivered over
// weeks or months. So the money a teacher has received is part *earned*
// (classes already taught — hers to keep) and part *paid in advance* (classes
// paid for but not yet taught — she still owes the work, and a refund would
// come out of it). This module makes that split visible, and files what she
// earned by the month she taught it, which is the question she actually asks:
// "what did September come to?" (D-191).
//
// Basis is what the student paid: the package price (`pricePaidMinorUnits`)
// over its class count. D-143 made her the merchant of record, so the only
// thing between that and what reaches her bank is Stripe's own processing fee
// on a card payment — charged on her own account and never seen by the
// platform, so never estimated here. That is why the money screens say the
// figures are what students paid, and that card payments land a little lower
// after Stripe's fee, which SpiralClass does not receive (D-152).
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

// A class still to come this month, on a package already paid for — what the
// rest of the month will add if it is taught as booked.
export type BookedLesson = {
  startsAt: Date;
  pricePerLessonMinorUnits: number;
  currency: string;
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
  // Who it was taught to — what a month's breakdown is grouped by.
  studentId: string;
  studentName: string;
};

// One student's share of one month.
export type StudentEarnings = {
  studentId: string;
  name: string;
  earnedCents: number;
  lessons: number;
};

// What one calendar month of teaching earned, in one currency.
export type MonthEarnings = {
  // `YYYY-MM` on the teacher's calendar.
  month: string;
  earnedCents: number;
  lessons: number;
  // The month split by student, largest first — the page of the notebook a
  // teacher used to keep. Apportioned so the rows add up to `earnedCents`
  // exactly, never a cent off the total printed above them.
  byStudent: StudentEarnings[];
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
  // What she earned teaching so far this calendar month, and how many classes.
  // The headline figure (D-191).
  // `YYYY-MM` of the current month on her calendar. Its own field because
  // `months` is empty until she has taught, and a teacher who has been paid
  // but not yet taught still has a current month to name.
  currentMonth: string;
  currentMonthEarnedCents: number;
  currentMonthLessons: number;
  // What the rest of this month adds if it is taught as booked: classes still
  // scheduled before the month ends, on packages already paid for. Real
  // bookings, not a projection from an average.
  bookedRestOfMonthCents: number;
  bookedRestOfMonthLessons: number;
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
  // Earned so far this calendar year — the figure she needs at tax time.
  // Within the history window by construction: January is never more than
  // eleven months back.
  yearToDateCents: number;
  // Her typical month, as a fact rather than advice: the mean and the lowest
  // of her COMPLETE months in the history — not the current month (not over),
  // and not her first month (she started part-way through it). Null until two
  // such months exist; one month is not a typical anything.
  typicalMonth: {
    averageCents: number;
    lowest: { month: string; earnedCents: number };
    months: number;
  } | null;
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
  // Classes still booked for the rest of the current month. Anything outside
  // the current month is ignored.
  booked?: BookedLesson[];
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
  { fallbackCurrency, preferCurrency, timeZone, booked = [] }: SummarizeOptions,
): CashFlow {
  const currencies = new Set<string>();
  for (const p of packages) currencies.add(p.currency);
  for (const l of completedLessons) currencies.add(l.currency);
  for (const l of booked) currencies.add(l.currency);
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
        booked.filter((l) => l.currency === currency),
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
  booked: BookedLesson[] = [],
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

  // Revenue and lesson count per month (and per student within it), summed
  // unrounded — a per-lesson price is the package price over its class count
  // and need not be whole — and rounded once per month below.
  type Tally = { revenue: number; lessons: number };
  const byMonth = new Map<string, Tally & { students: Map<string, Tally & { name: string }> }>();
  for (const l of completedLessons) {
    const key = monthKey(l.taughtAt, timeZone);
    let month = byMonth.get(key);
    if (!month) byMonth.set(key, (month = { revenue: 0, lessons: 0, students: new Map() }));
    month.revenue += l.pricePerLessonMinorUnits;
    month.lessons += 1;
    let student = month.students.get(l.studentId);
    if (!student) {
      month.students.set(l.studentId, (student = { revenue: 0, lessons: 0, name: l.studentName }));
    }
    student.revenue += l.pricePerLessonMinorUnits;
    student.lessons += 1;
  }
  const revenueIn = (key: string) => byMonth.get(key)?.revenue ?? 0;

  const historyLength = Math.min(monthsElapsed, EARNINGS_HISTORY_MONTHS);
  const months: MonthEarnings[] = [];
  for (let back = 0; back < historyLength; back++) {
    const key = shiftMonthKey(currentMonth, -back);
    const month = byMonth.get(key);
    const earned = Math.round(month?.revenue ?? 0);
    const students = [...(month?.students ?? new Map()).entries()];
    const shares = apportion(
      earned,
      students.map(([, st]) => st.revenue),
    );
    months.push({
      month: key,
      earnedCents: earned,
      lessons: month?.lessons ?? 0,
      byStudent: students
        .map(([studentId, st], i) => ({
          studentId,
          name: st.name,
          earnedCents: shares[i],
          lessons: st.lessons,
        }))
        .sort((a, b) => b.earnedCents - a.earnedCents || a.name.localeCompare(b.name)),
    });
  }
  const previousMonth = byMonth.get(shiftMonthKey(currentMonth, -1));

  // The rest of this month, as booked.
  let bookedRestOfMonth = 0;
  let bookedRestOfMonthLessons = 0;
  for (const l of booked) {
    if (l.startsAt > now && monthKey(l.startsAt, timeZone) === currentMonth) {
      bookedRestOfMonth += l.pricePerLessonMinorUnits;
      bookedRestOfMonthLessons += 1;
    }
  }

  const currentYear = currentMonth.slice(0, 4);
  const yearToDateCents = Math.round(
    [...byMonth.entries()]
      .filter(([key]) => key.startsWith(currentYear) && key <= currentMonth)
      .reduce((sum, [, m]) => sum + m.revenue, 0),
  );

  // Complete months: everything in the history but the current month and her
  // first-ever month.
  const complete = months.filter((m) => m.month !== currentMonth && m.month !== firstMonth);
  let typicalMonth: CashFlowSummary["typicalMonth"] = null;
  if (complete.length >= 2) {
    const lowest = complete.reduce((low, m) => (m.earnedCents < low.earnedCents ? m : low));
    typicalMonth = {
      averageCents: Math.round(
        complete.reduce((sum, m) => sum + m.earnedCents, 0) / complete.length,
      ),
      lowest: { month: lowest.month, earnedCents: lowest.earnedCents },
      months: complete.length,
    };
  }

  return {
    currency,
    totalPaidCents,
    earnedCents,
    heldCents,
    heldLessons,
    currentMonth,
    currentMonthEarnedCents: Math.round(revenueIn(currentMonth)),
    currentMonthLessons: byMonth.get(currentMonth)?.lessons ?? 0,
    previousMonthEarnedCents: Math.round(previousMonth?.revenue ?? 0),
    previousMonthLessons: previousMonth?.lessons ?? 0,
    months,
    bookedRestOfMonthCents: Math.round(bookedRestOfMonth),
    bookedRestOfMonthLessons,
    yearToDateCents,
    typicalMonth,
  };
}

/**
 * Split an integer `total` across `weights` so the parts are integers that add
 * up to exactly `total` (largest-remainder). Rounding each share on its own can
 * leave a month's students a cent short of — or over — the month total printed
 * above them; this hands the leftover cents to the largest fractional parts.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const parts = exact.map(Math.floor);
  let leftover = total - parts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    parts[i] += 1;
    leftover -= 1;
  }
  return parts;
}

// A no-show is forfeited time the teacher earned (D-12): it is delivered for
// the earned/held split, so it is earned in the month it was booked for too.
// One list, so the monthly figures and the all-time split cannot disagree
// about what counts.
const DELIVERED_STATUSES = ["completed", "no_show"] as const;

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

  const [packages, deliveredGroups, completed, firstDelivered, teacher, upcoming] =
    await Promise.all([
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
        where: { teacherId, status: { in: [...DELIVERED_STATUSES] } },
        _count: { _all: true },
      }),
      // Delivered lessons taught in the window (through now), with their package
      // price and currency — the price to derive per-lesson revenue, the
      // currency to file it under the right slice — and the student, for the
      // month's breakdown. Served by the (teacher_id, scheduled_start) index.
      prisma.booking.findMany({
        where: {
          teacherId,
          status: { in: [...DELIVERED_STATUSES] },
          scheduledStart: { gte: windowStart, lte: now },
        },
        select: {
          scheduledStart: true,
          student: { select: { id: true, name: true } },
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
        where: { teacherId, status: { in: [...DELIVERED_STATUSES] } },
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
      // Classes still to come in the next month and a bit, on paid packages —
      // the pure function keeps the ones left in HER current month.
      prisma.booking.findMany({
        where: {
          teacherId,
          status: "scheduled",
          scheduledStart: { gt: now, lt: new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000) },
          package: { status: { in: [...PAID_STATUSES] } },
        },
        select: {
          scheduledStart: true,
          package: { select: { pricePaidMinorUnits: true, classesTotal: true, currency: true } },
        },
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
      studentId: b.student.id,
      studentName: b.student.name,
    }));

  const booked: BookedLesson[] = upcoming
    .filter((b) => b.package.classesTotal > 0)
    .map((b) => ({
      startsAt: b.scheduledStart,
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
      booked,
    },
  );
}
