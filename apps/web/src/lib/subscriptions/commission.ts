import { COMMISSION_WINDOW_MONTHS } from "./config";

// Ambassador commission computation (pure). An ambassador referral is
// platform-funded and paid out of band (see docs/features/referrals-discounts.md):
// the only computable piece is a share of the NET of each PAID subscription
// invoice within the referred account's first COMMISSION_WINDOW_MONTHS (12)
// months. Free/trial teachers produce no invoices, so a referral that never
// upgrades earns nothing. Refunded/voided invoices are excluded (clawback) by
// only counting status === "paid".
//
// The RATE is deployment configuration, never a constant in this tree: it is
// the term of a private arrangement and this repository is public. Every
// function below takes it as an argument, defaulted from the environment, so
// the arithmetic is testable at any rate and the real one is set once,
// alongside the deployment's other configuration.

/**
 * Share of net payable to an ambassador, as a 0-1 fraction.
 *
 * `COMMISSION_RATE_PERCENT` is a whole number (25 means 25%). Absent, blank or
 * out of range resolves to 0: the report then shows a zero payable, which is
 * visibly unconfigured rather than a plausible wrong number a manual transfer
 * could be made against.
 */
export function commissionRate(): number {
  const raw = Number(process.env.COMMISSION_RATE_PERCENT);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 100) return 0;
  return raw / 100;
}

export type CommissionTeacher = {
  id: string;
  name: string;
  referralSource: string | null;
  // Account start — the first-12-months window anchors here.
  createdAt: Date;
};

export type CommissionInvoice = {
  teacherId: string;
  invoiceId: string;
  netMinorUnits: number;
  status: "paid" | "open" | "failed" | "void";
  paidAt: Date | null;
  periodStart: Date;
};

export type CommissionLineItem = {
  teacherId: string;
  teacherName: string;
  invoiceId: string;
  periodStart: Date;
  netMinorUnits: number;
  payableMinorUnits: number;
};

export type AmbassadorCommission = {
  ambassador: string;
  referredTeacherCount: number;
  lineItems: CommissionLineItem[];
  totalNetMinorUnits: number;
  totalPayableMinorUnits: number;
};

// Add `months` calendar months to a date (clamps day-of-month overflow, e.g.
// Jan 31 + 1mo → Feb 28/29). Used for the 12-month window edge.
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const result = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      targetMonth,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  // Handle overflow (e.g. day 31 rolling into the next month).
  if (result.getUTCDate() !== d.getUTCDate()) {
    result.setUTCDate(0);
  }
  return result;
}

// The payable for a single net amount, rounded to the minor unit.
export function payableForNet(netMinorUnits: number, rate: number = commissionRate()): number {
  return Math.round(netMinorUnits * rate);
}

// True when `invoiceDate` falls within [accountStart, accountStart + 12 months).
export function withinCommissionWindow(accountStart: Date, invoiceDate: Date): boolean {
  if (invoiceDate.getTime() < accountStart.getTime()) return false;
  const windowEnd = addMonths(accountStart, COMMISSION_WINDOW_MONTHS);
  return invoiceDate.getTime() < windowEnd.getTime();
}

// Compute per-ambassador commission from referred teachers + their invoices.
// Only teachers with a non-null referralSource are attributed.
export function computeCommission(input: {
  teachers: CommissionTeacher[];
  invoices: CommissionInvoice[];
  /** 0-1 fraction of net. Defaults to the deployment's configured rate. */
  rate?: number;
}): AmbassadorCommission[] {
  const rate = input.rate ?? commissionRate();
  const teacherById = new Map(input.teachers.map((t) => [t.id, t]));
  const byAmbassador = new Map<string, AmbassadorCommission>();

  // Seed referred-teacher counts (so an ambassador with referrals but no paid
  // invoices still shows up with 0 payable).
  const referredByAmbassador = new Map<string, Set<string>>();
  for (const t of input.teachers) {
    if (!t.referralSource) continue;
    if (!referredByAmbassador.has(t.referralSource)) {
      referredByAmbassador.set(t.referralSource, new Set());
    }
    referredByAmbassador.get(t.referralSource)!.add(t.id);
  }

  for (const [ambassador, teacherIds] of referredByAmbassador) {
    byAmbassador.set(ambassador, {
      ambassador,
      referredTeacherCount: teacherIds.size,
      lineItems: [],
      totalNetMinorUnits: 0,
      totalPayableMinorUnits: 0,
    });
  }

  for (const inv of input.invoices) {
    // Clawback: only PAID invoices count; refunded/voided/failed/open excluded.
    if (inv.status !== "paid") continue;
    const teacher = teacherById.get(inv.teacherId);
    if (!teacher?.referralSource) continue;
    // Window anchored on the invoice's paid date (falls back to periodStart).
    const invoiceDate = inv.paidAt ?? inv.periodStart;
    if (!withinCommissionWindow(teacher.createdAt, invoiceDate)) continue;

    const entry = byAmbassador.get(teacher.referralSource);
    if (!entry) continue;
    const payableMinorUnits = payableForNet(inv.netMinorUnits, rate);
    entry.lineItems.push({
      teacherId: teacher.id,
      teacherName: teacher.name,
      invoiceId: inv.invoiceId,
      periodStart: inv.periodStart,
      netMinorUnits: inv.netMinorUnits,
      payableMinorUnits,
    });
    entry.totalNetMinorUnits += inv.netMinorUnits;
    entry.totalPayableMinorUnits += payableMinorUnits;
  }

  return [...byAmbassador.values()].sort((a, b) => a.ambassador.localeCompare(b.ambassador));
}
