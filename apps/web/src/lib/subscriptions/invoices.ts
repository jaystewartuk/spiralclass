import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// The teacher's own billing history.
//
// `subscription_invoices` has been written by the billing webhook since the
// rail shipped and read only by the admin console — the teacher who was
// actually charged had no way to see what she had paid without opening the
// Stripe Customer Portal, which is a redirect off the product for a question
// the product already knows the answer to.
//
// Deliberately reads the row rather than calling Stripe: these rows are the
// platform's own record, they carry the currency each charge actually settled
// in (a pre-D-99 subscriber's history is genuinely in MXN and must not be
// re-denominated into GBP), and a settings page must not hard-depend on a
// third-party API being up.

type Tx = Prisma.TransactionClient | PrismaClient;

// How many rows the history shows. Monthly billing makes this a bit over a
// year, which is the span anyone actually scans; the Customer Portal is the
// link out for a full archive.
export const BILLING_HISTORY_LIMIT = 12;

export type BillingHistoryEntry = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinorUnits: number;
  // The currency THIS charge settled in, never the platform's current one.
  currency: string;
  status: "paid" | "open" | "failed" | "void";
  paidAt: Date | null;
};

// The most recent invoices for a teacher, newest first. `void` rows are
// excluded: a voided invoice was never owed and never paid, so showing it
// invites the "was I charged twice?" question it cannot answer. A `failed` row
// stays — that one the teacher needs to see.
export async function listBillingHistory(
  teacherId: string,
  tx: Tx = prisma,
  limit: number = BILLING_HISTORY_LIMIT,
): Promise<BillingHistoryEntry[]> {
  const rows = await tx.subscriptionInvoice.findMany({
    where: { teacherId, status: { not: "void" } },
    orderBy: { periodStart: "desc" },
    take: limit,
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      amountMinorUnits: true,
      currency: true,
      status: true,
      paidAt: true,
    },
  });
  return rows as BillingHistoryEntry[];
}
