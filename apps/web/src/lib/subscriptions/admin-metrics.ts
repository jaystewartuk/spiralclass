import { prisma } from "@/lib/prisma";
import { PLATFORM_MONEY_CURRENCY } from "@spiralclass/shared";
import {
  TRIAL_ENDING_NOTICE_DAYS,
  monthlyEquivalentMinorUnits,
  monthlyEquivalentOfPrice,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from "./config";
import { getFoundingCohortState } from "./service";
import { computeCommission, type AmbassadorCommission, type CommissionInvoice } from "./commission";

// Admin read models for the subscription/MRR overview and the ambassador
// commission report. Service-role reads (admin console only).

export type SubscriptionOverview = {
  byPlan: Record<SubscriptionPlan, number>;
  byStatus: Record<SubscriptionStatus, number>;
  // Monthly Recurring Revenue in the canonical currency (PLATFORM_MONEY_CURRENCY,
  // GBP as of D-99) — sum of the monthly-equivalent of every actively-billed
  // (non-comped) subscription THAT BILLS IN THAT CURRENCY. Annual is /12.
  // Computed from each row's own persisted `lockedPriceMinorUnits`, never
  // re-derived from today's config table — a subscriber's locked price is
  // deliberately allowed to differ from it (founding lock, or a pre-D-99 MXN
  // subscriber who hasn't renewed under the new currency yet).
  mrrMinorUnits: number;
  // A subscriber billing in any OTHER currency (e.g. a not-yet-renewed
  // pre-D-99 MXN subscription) contributes here instead of mrrMinorUnits —
  // summing two currencies' raw minor units together would be meaningless, so
  // this is surfaced separately rather than blended (mirrors
  // money-metrics.ts's expense/revenue currency split).
  mrrOtherCurrencyMinorUnits: Record<string, number>;
  trialingCount: number;
  trialsEndingSoon: number;
  pastDueCount: number;
  freeCount: number;
  paidCount: number;
  compedCount: number;
  founding: { headcount: number; cap: number; cutoffAt: Date; isOpen: boolean };
};

export async function getSubscriptionOverview(
  now: Date = new Date(),
): Promise<SubscriptionOverview> {
  const subs = await prisma.teacherSubscription.findMany({
    select: {
      plan: true,
      status: true,
      comped: true,
      trialEndsAt: true,
      lockedPriceMinorUnits: true,
      currency: true,
    },
  });

  const byPlan: Record<SubscriptionPlan, number> = { free: 0, monthly: 0, annual: 0, founding: 0 };
  const byStatus: Record<SubscriptionStatus, number> = {
    trialing: 0,
    active: 0,
    past_due: 0,
    canceled: 0,
    free: 0,
  };
  let mrrMinorUnits = 0;
  const mrrOtherCurrencyMinorUnits: Record<string, number> = {};
  let trialsEndingSoon = 0;
  let compedCount = 0;
  const soonCutoff = new Date(now.getTime() + TRIAL_ENDING_NOTICE_DAYS * 24 * 60 * 60 * 1000);

  for (const s of subs) {
    byPlan[s.plan] += 1;
    byStatus[s.status] += 1;
    if (s.comped) compedCount += 1;
    // MRR: actively-billed paid plans only (active or past_due still counts as
    // billed; comped contributes nothing).
    if (!s.comped && (s.status === "active" || s.status === "past_due")) {
      // A row should always have its own locked price by the time it's
      // active/past_due (activateSubscription always sets it); the config-table
      // fallback only guards a legacy/malformed row that somehow lacks one.
      const monthly =
        s.lockedPriceMinorUnits != null
          ? monthlyEquivalentOfPrice(s.plan, s.lockedPriceMinorUnits)
          : monthlyEquivalentMinorUnits(s.plan, s.currency);
      if (s.currency === PLATFORM_MONEY_CURRENCY) {
        mrrMinorUnits += monthly;
      } else {
        mrrOtherCurrencyMinorUnits[s.currency] =
          (mrrOtherCurrencyMinorUnits[s.currency] ?? 0) + monthly;
      }
    }
    if (
      s.status === "trialing" &&
      s.trialEndsAt &&
      s.trialEndsAt > now &&
      s.trialEndsAt <= soonCutoff
    ) {
      trialsEndingSoon += 1;
    }
  }

  const founding = await getFoundingCohortState(now);
  const paidCount = byPlan.monthly + byPlan.annual + byPlan.founding;

  return {
    byPlan,
    byStatus,
    mrrMinorUnits,
    mrrOtherCurrencyMinorUnits,
    trialingCount: byStatus.trialing,
    trialsEndingSoon,
    pastDueCount: byStatus.past_due,
    freeCount: byStatus.free,
    paidCount,
    compedCount,
    founding,
  };
}

// Wise-billed subscriptions (docs D-NN manual/Wise rail — see
// app/actions/admin-subscriptions.ts) whose current period is due within
// `windowDays` or already elapsed. There is no automated bank reconciliation
// for this rail, so this is the admin's worklist: who to chase for the
// transfer and mark paid via markSubscriptionPaidManually. "Wise-billed" is
// inferred from the teacher's most recent invoice provider — the
// subscription itself doesn't carry a rail flag.
export type WiseRenewalDue = {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  plan: SubscriptionPlan;
  lockedPriceMinorUnits: number | null;
  currentPeriodEnd: Date;
  overdue: boolean;
};

export async function getWiseRenewalsDue(
  now: Date = new Date(),
  windowDays = 7,
): Promise<WiseRenewalDue[]> {
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const subs = await prisma.teacherSubscription.findMany({
    where: {
      status: { in: ["active", "past_due"] },
      comped: false,
      currentPeriodEnd: { not: null, lte: windowEnd },
    },
    select: {
      teacherId: true,
      plan: true,
      lockedPriceMinorUnits: true,
      currentPeriodEnd: true,
      teacher: { select: { name: true, email: true } },
    },
  });
  if (subs.length === 0) return [];

  // One query for every candidate's invoice history, newest first; keep the
  // first (= latest) row seen per teacher rather than a findFirst-per-teacher
  // N+1.
  const invoices = await prisma.subscriptionInvoice.findMany({
    where: { teacherId: { in: subs.map((s) => s.teacherId) } },
    orderBy: { periodStart: "desc" },
    select: { teacherId: true, provider: true },
  });
  const latestProviderByTeacher = new Map<string, string>();
  for (const inv of invoices) {
    if (!latestProviderByTeacher.has(inv.teacherId)) {
      latestProviderByTeacher.set(inv.teacherId, inv.provider);
    }
  }

  return (
    subs
      // `manual` since D-113 split the billing provider off the payout rail's
      // enum. In practice that still means Wise — it is the only way a teacher
      // pays SpiralClass outside Stripe — but the value names the concern
      // (an admin recorded a transfer we received) rather than the vendor.
      .filter((s) => latestProviderByTeacher.get(s.teacherId) === "manual")
      .map((s) => ({
        teacherId: s.teacherId,
        teacherName: s.teacher.name,
        teacherEmail: s.teacher.email,
        plan: s.plan,
        lockedPriceMinorUnits: s.lockedPriceMinorUnits,
        currentPeriodEnd: s.currentPeriodEnd!,
        overdue: s.currentPeriodEnd! <= now,
      }))
      .sort((a, b) => a.currentPeriodEnd.getTime() - b.currentPeriodEnd.getTime())
  );
}

// The ambassador commission report: referred teachers + their PAID invoices in
// the first 12 months, 50% of net payable. Pure math lives in commission.ts.
export async function getCommissionReport(): Promise<AmbassadorCommission[]> {
  const teachers = await prisma.teacher.findMany({
    where: { referralSource: { not: null } },
    select: { id: true, name: true, referralSource: true, createdAt: true },
  });
  const teacherIds = teachers.map((t) => t.id);
  if (teacherIds.length === 0) return [];

  const invoices = await prisma.subscriptionInvoice.findMany({
    where: { teacherId: { in: teacherIds } },
    select: {
      teacherId: true,
      id: true,
      netMinorUnits: true,
      status: true,
      paidAt: true,
      periodStart: true,
    },
  });

  const wireInvoices: CommissionInvoice[] = invoices.map((i) => ({
    teacherId: i.teacherId,
    invoiceId: i.id,
    netMinorUnits: i.netMinorUnits,
    status: i.status,
    paidAt: i.paidAt,
    periodStart: i.periodStart,
  }));

  return computeCommission({ teachers, invoices: wireInvoices });
}
