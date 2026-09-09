// Platform money metrics — the owner's business-of-record view, read straight
// from Postgres (never event analytics). Three things the per-teacher
// cash-flow lib and the subscription overview don't already cover:
//
//   1. Collected subscription revenue over time — since D-143 the platform's
//      ONLY revenue line, from PAID subscription invoices (not run-rate MRR,
//      which is a snapshot).
//   2. GMV over time — gross payment volume flowing to teachers, split by
//      rail. This is a scale metric and NOT revenue in any part: direct
//      charges settle on the teacher's own Stripe account, so none of it ever
//      reaches the platform's balance. The commission series that used to sit
//      here (`getCommissionSeries`, D-58 pivot) is gone with the Transfer it
//      was withheld from — do not reintroduce a revenue reading of GMV.
//   3. Platform-wide deferred-revenue liability — the aggregate of the same
//      earned-vs-held split cashflow.ts computes per teacher, on the
//      teacher's actual net (gross less Stripe's own fee).
//
// MRR + subscriber mix already live in subscriptions/admin-metrics.ts
// (`getSubscriptionOverview`); this module deliberately does NOT duplicate them.
//
// Money is centavos (integer). Both the subscription-revenue and
// running-cost series are scoped to ONE currency at a time — the platform's
// canonical PLATFORM_MONEY_CURRENCY (GBP as of D-99) by default — and any row
// in a different currency (a not-yet-renewed pre-D-99 MXN subscription
// invoice, a hand-entered USD/GBP expense) is EXCLUDED from the summed total
// and surfaced separately instead (see `otherCurrency*Totals`). This app has
// no FX-rate source, so silently blending two currencies' raw minor units
// together would just be wrong. Month buckets are UTC calendar months,
// matching the boundary convention in cashflow.ts so the two money surfaces
// can't drift.

import { prisma } from "@/lib/prisma";
import { summarizeCashFlow, type CashFlow } from "@/lib/cashflow";
import {
  DEFAULT_PRICING_CURRENCY,
  EXPENSE_CATEGORIES,
  PLATFORM_MONEY_CURRENCY,
  type ExpenseCategory,
} from "@spiralclass/shared";

// Same "carries received cash" set cashflow.ts uses: a package only holds cash
// once payment confirms (active/paused/expired); pending = unpaid, refunded =
// reversed.
const PAID_PACKAGE_STATUSES = ["active", "paused", "expired"] as const;

// --- Month bucketing (pure) ------------------------------------------------

// "YYYY-MM" for the UTC calendar month containing `d`.
export function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// The `count` most recent UTC calendar months, oldest first, ending with the
// (partial) month containing `now`. This is the fixed x-axis every series is
// zero-filled against, so a month with no activity still shows as an empty bar
// instead of vanishing.
export function recentMonths(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

// Start of the oldest bucket in a `count`-month window — the inclusive lower
// bound for the DB query that feeds a series.
export function monthWindowStart(now: Date, count: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1), 1));
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// "2026-07" → "Jul '26". Locale-free on purpose (the whole admin console is
// English) and short enough to sit on a chart's category axis.
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const idx = Number(m) - 1;
  const abbr = MONTH_ABBR[idx] ?? m;
  return `${abbr} '${y.slice(2)}`;
}

// --- Collected subscription revenue over time ------------------------------

// One month of realized subscription revenue: what was actually invoiced-paid,
// its fee, and the net the platform keeps.
export type RevenuePoint = {
  month: string;
  grossMinorUnits: number;
  feeMinorUnits: number;
  netMinorUnits: number;
};

export type PaidInvoice = {
  paidAt: Date;
  amountMinorUnits: number;
  feeMinorUnits: number;
  netMinorUnits: number;
  currency: string;
};

// Pure: bucket PAID invoices into the given months, zero-filled and in order.
// Invoices outside the window are ignored (the query already bounds them, but
// keeping the guard makes the function safe to reuse on any input). Only
// invoices in `primaryCurrency` (default: the platform's canonical currency)
// are summed — a different-currency invoice (a not-yet-renewed pre-D-99 MXN
// subscription) is excluded; see `otherCurrencyRevenueTotals` for those.
export function summarizeRevenueSeries(
  invoices: PaidInvoice[],
  months: string[],
  primaryCurrency: string = PLATFORM_MONEY_CURRENCY,
): RevenuePoint[] {
  const byMonth = new Map<string, RevenuePoint>(
    months.map((month) => [
      month,
      { month, grossMinorUnits: 0, feeMinorUnits: 0, netMinorUnits: 0 },
    ]),
  );
  for (const inv of invoices) {
    if (inv.currency !== primaryCurrency) continue;
    const point = byMonth.get(monthKey(inv.paidAt));
    if (!point) continue;
    point.grossMinorUnits += inv.amountMinorUnits;
    point.feeMinorUnits += inv.feeMinorUnits;
    point.netMinorUnits += inv.netMinorUnits;
  }
  return months.map((month) => byMonth.get(month)!);
}

// Paid invoices in any OTHER currency than `primaryCurrency`, grouped by
// currency and summed (net) — whatever summarizeRevenueSeries excluded.
// Callers render this as a "not included above" note rather than guessing an
// exchange rate, mirroring otherCurrencyExpenseTotals below.
export function otherCurrencyRevenueTotals(
  invoices: PaidInvoice[],
  primaryCurrency: string = PLATFORM_MONEY_CURRENCY,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const inv of invoices) {
    if (inv.currency === primaryCurrency) continue;
    totals[inv.currency] = (totals[inv.currency] ?? 0) + inv.netMinorUnits;
  }
  return totals;
}

export async function getSubscriptionRevenueSeries(
  monthsBack = 6,
  now: Date = new Date(),
): Promise<{ series: RevenuePoint[]; otherCurrencyTotals: Record<string, number> }> {
  const months = recentMonths(now, monthsBack);
  const invoices = await prisma.subscriptionInvoice.findMany({
    where: { status: "paid", paidAt: { not: null, gte: monthWindowStart(now, monthsBack) } },
    select: {
      paidAt: true,
      amountMinorUnits: true,
      feeMinorUnits: true,
      netMinorUnits: true,
      currency: true,
    },
  });
  const wireInvoices = invoices.map((i) => ({
    paidAt: i.paidAt as Date,
    amountMinorUnits: i.amountMinorUnits,
    feeMinorUnits: i.feeMinorUnits,
    netMinorUnits: i.netMinorUnits,
    currency: i.currency,
  }));
  return {
    series: summarizeRevenueSeries(wireInvoices, months),
    otherCurrencyTotals: otherCurrencyRevenueTotals(wireInvoices),
  };
}

// --- GMV (gross payment volume) over time ----------------------------------

// One month of gross volume flowing to teachers, split by settlement rail.
// `total` includes every paid payment; `card`+`wise` may be less than `total`
// when older payments carry rail=unknown.
export type GmvPoint = {
  month: string;
  cardMinorUnits: number;
  wiseMinorUnits: number;
  totalMinorUnits: number;
};

export type PaidPayment = {
  paidAt: Date;
  amountMinorUnits: number;
  rail: string;
};

// Pure: bucket PAID payments into months, splitting by rail.
export function summarizeGmvSeries(payments: PaidPayment[], months: string[]): GmvPoint[] {
  const byMonth = new Map<string, GmvPoint>(
    months.map((month) => [
      month,
      { month, cardMinorUnits: 0, wiseMinorUnits: 0, totalMinorUnits: 0 },
    ]),
  );
  for (const p of payments) {
    const point = byMonth.get(monthKey(p.paidAt));
    if (!point) continue;
    point.totalMinorUnits += p.amountMinorUnits;
    if (p.rail === "card") point.cardMinorUnits += p.amountMinorUnits;
    else if (p.rail === "wise") point.wiseMinorUnits += p.amountMinorUnits;
  }
  return months.map((month) => byMonth.get(month)!);
}

export async function getGmvSeries(monthsBack = 6, now: Date = new Date()): Promise<GmvPoint[]> {
  const months = recentMonths(now, monthsBack);
  const payments = await prisma.payment.findMany({
    where: { status: "paid", paidAt: { not: null, gte: monthWindowStart(now, monthsBack) } },
    select: { paidAt: true, amountMinorUnits: true, rail: true },
  });
  return summarizeGmvSeries(
    payments.map((p) => ({
      paidAt: p.paidAt as Date,
      amountMinorUnits: p.amountMinorUnits,
      rail: p.rail,
    })),
    months,
  );
}

// --- Platform running costs (manually entered) ------------------------------
//
// The costs side of P&L, structured from docs/deployment/COST_PLAYBOOK.md — see
// PlatformExpense in schema.prisma. Deliberately separate from the revenue
// series above (different source, different confidence: revenue is derived
// from Stripe-confirmed rows, costs are hand-entered from invoices/statements).

export type ExpensePoint = {
  month: string;
  // Scoped to one currency, see summarizeExpenseSeries.
  totalMinorUnits: number;
  byCategory: Record<ExpenseCategory, number>;
};

export type PlatformExpenseRow = {
  periodMonth: Date;
  amountMinorUnits: number;
  currency: string;
  category: ExpenseCategory;
};

function emptyCategoryTotals(): Record<ExpenseCategory, number> {
  return Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])) as Record<
    ExpenseCategory,
    number
  >;
}

// Pure: bucket expense rows in `primaryCurrency` (default: the platform's
// canonical currency) into the given months, zero-filled. Rows in any other
// currency are excluded on purpose — see otherCurrencyExpenseTotals. This app
// has no FX-rate source, so silently converting them would just be wrong;
// they're surfaced separately instead of folded into a blended total.
export function summarizeExpenseSeries(
  rows: PlatformExpenseRow[],
  months: string[],
  primaryCurrency: string = PLATFORM_MONEY_CURRENCY,
): ExpensePoint[] {
  const byMonth = new Map<string, ExpensePoint>(
    months.map((month) => [
      month,
      { month, totalMinorUnits: 0, byCategory: emptyCategoryTotals() },
    ]),
  );
  for (const row of rows) {
    if (row.currency !== primaryCurrency) continue;
    const point = byMonth.get(monthKey(row.periodMonth));
    if (!point) continue;
    point.totalMinorUnits += row.amountMinorUnits;
    point.byCategory[row.category] += row.amountMinorUnits;
  }
  return months.map((month) => byMonth.get(month)!);
}

// Rows in any OTHER currency than `primaryCurrency`, grouped by currency —
// whatever summarizeExpenseSeries excluded. Callers render this as a "not
// included above" note rather than guessing an exchange rate.
export function otherCurrencyExpenseTotals(
  rows: PlatformExpenseRow[],
  primaryCurrency: string = PLATFORM_MONEY_CURRENCY,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (row.currency === primaryCurrency) continue;
    totals[row.currency] = (totals[row.currency] ?? 0) + row.amountMinorUnits;
  }
  return totals;
}

export async function getPlatformExpenseSeries(
  monthsBack = 6,
  now: Date = new Date(),
): Promise<{ series: ExpensePoint[]; otherCurrencyTotals: Record<string, number> }> {
  const months = recentMonths(now, monthsBack);
  const rows = await prisma.platformExpense.findMany({
    where: { periodMonth: { gte: monthWindowStart(now, monthsBack) } },
    select: { periodMonth: true, amountMinorUnits: true, currency: true, category: true },
  });
  return {
    series: summarizeExpenseSeries(rows, months),
    otherCurrencyTotals: otherCurrencyExpenseTotals(rows),
  };
}

// --- Net profit (subscription revenue − costs) -----------------------------
//
// Subscription revenue is the ONLY revenue line since D-143. The marketplace
// commission that used to sit here was withheld from the teacher payout, which
// direct charges removed: the money settles on her account and never reaches
// the platform's balance to be withheld from.

export type NetProfitPoint = {
  month: string;
  revenueNetMinorUnits: number;
  expenseMinorUnits: number;
  netProfitMinorUnits: number;
};

// Pure: combine two independently-fetched series into one profit line, keyed
// by month string (not index) so callers don't need to guarantee identical
// array ordering — only that `revenue` carries the canonical month list.
export function summarizeNetProfitSeries(
  revenue: RevenuePoint[],
  expense: ExpensePoint[],
): NetProfitPoint[] {
  const expenseByMonth = new Map(expense.map((e) => [e.month, e.totalMinorUnits]));
  return revenue.map((r) => {
    const expenseMinorUnits = expenseByMonth.get(r.month) ?? 0;
    return {
      month: r.month,
      revenueNetMinorUnits: r.netMinorUnits,
      expenseMinorUnits,
      netProfitMinorUnits: r.netMinorUnits - expenseMinorUnits,
    };
  });
}

// --- Platform-wide deferred-revenue liability ------------------------------

// The aggregate earned-vs-held split across ALL teachers. Reuses
// summarizeCashFlow with an empty completed-lessons set: its totalPaid/earned/
// held/heldLessons math is teacher-agnostic (only safe-monthly-spend is a
// per-teacher concept, and that field is meaningless — and left at 0 — here).
//
// **Mixed-currency by construction**, unlike the per-teacher figure: two
// teachers pricing differently is the ordinary case, not an edge one, so this
// roll-up can never be a single scalar. It comes back per currency, largest
// pile first, on the same "never blend, no FX rate exists" rule as the
// subscription-revenue series at the top of this file.
//
// Scans every paid package platform-wide. Fine at current scale; if the table
// grows large this is the first thing to move to a windowed/materialized query.
export async function computePlatformDeferredRevenue(now: Date = new Date()): Promise<CashFlow> {
  const [packages, deliveredGroups] = await Promise.all([
    prisma.package.findMany({
      where: { status: { in: [...PAID_PACKAGE_STATUSES] } },
      select: {
        id: true,
        classesTotal: true,
        pricePaidMinorUnits: true,
        currency: true,
        status: true,
        expiresAt: true,
      },
    }),
    prisma.booking.groupBy({
      by: ["packageId"],
      where: { status: { in: ["completed", "no_show"] } },
      _count: { _all: true },
    }),
  ]);

  const deliveredByPkg = new Map(deliveredGroups.map((g) => [g.packageId, g._count._all]));

  return summarizeCashFlow(
    packages.map((p) => ({
      classesTotal: p.classesTotal,
      pricePaidMinorUnits: p.pricePaidMinorUnits,
      currency: p.currency,
      status: p.status as (typeof PAID_PACKAGE_STATUSES)[number],
      expiresAt: p.expiresAt,
      deliveredLessons: deliveredByPkg.get(p.id) ?? 0,
    })),
    [],
    null,
    now,
    // No `preferCurrency`: there is no "the platform's pricing currency" to
    // lead with, so the biggest pile leads. The fallback only decides what an
    // empty platform is denominated in.
    { fallbackCurrency: DEFAULT_PRICING_CURRENCY },
  );
}
