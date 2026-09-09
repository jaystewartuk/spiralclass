import type { PrismaClient } from "@prisma/client";

import { confirmTransferPayment } from "./transfer-confirm";
import type { WebhookEventEmitter } from "./webhook-handler";
import type { WiseClient, WiseCredit, TeacherWiseCreds } from "@/lib/wise/api";
import { logger } from "@/lib/logger";

const log = logger({ surface: "wise-reconcile" });

// Automated Wise reconciliation — PER TEACHER.
//
// For every teacher who has connected their own Wise Business API
// credentials, reads incoming credits off THAT teacher's balance statement
// and auto-confirms any of THAT teacher's pending Wise payments whose
// reference AND amount match a credit. Reference match alone is never
// enough — an amount mismatch is
// surfaced for manual review rather than auto-confirmed, so a fat-fingered
// transfer can't silently activate a package for the wrong price.
//
// Driven by the poll-wise-statements Inngest cron. The matcher is a pure
// function (`matchCredits`) so the safety rules are unit-tested without a DB
// or network.

// Accepts both the legacy 8-hex references and the widened 12-hex ones (audit
// M-8/L-4). Greedy so a 12-char reference in a free-text memo is captured in
// full; references are bounded by spaces/punctuation in Wise memos, and legacy
// 8-char ones have nothing more to grab.
const REFERENCE_RE = /AGP-[0-9A-Z]{8,12}/i;

// Pulls the canonical "AGP-XXXXXXXX" token out of arbitrary statement
// reference text (Wise senders often prepend/append their own words).
// Returns the uppercased token or null.
export function extractReference(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(REFERENCE_RE);
  return m ? m[0].toUpperCase() : null;
}

export type ReconcilePayment = {
  id: string;
  paymentReference: string | null;
  amountMinorUnits: number;
  // The currency this payment was priced in. The Wise credit must land in the
  // same currency to auto-confirm (compared against this, not a global const).
  currency: string;
};

export type CreditMatch = { paymentId: string; credit: WiseCredit };
export type CreditMismatch = {
  paymentId: string;
  credit: WiseCredit;
  reason: "amount" | "currency";
};

export type MatchResult = {
  matches: CreditMatch[];
  // Reference matched a pending payment but the credit can't be trusted to
  // confirm it. Left for the teacher to resolve manually.
  mismatches: CreditMismatch[];
};

// Pure matcher. Each pending payment is matched at most once; each credit is
// consumed by at most one payment. Reference is the join key (unique per
// payment); amount + matching currency are the guard.
export function matchCredits(credits: WiseCredit[], payments: ReconcilePayment[]): MatchResult {
  const byReference = new Map<string, ReconcilePayment>();
  for (const p of payments) {
    if (p.paymentReference) {
      byReference.set(p.paymentReference.toUpperCase(), p);
    }
  }

  const matches: CreditMatch[] = [];
  const mismatches: CreditMismatch[] = [];
  const consumedPayments = new Set<string>();

  for (const credit of credits) {
    const ref = extractReference(credit.reference);
    if (!ref) continue;
    const payment = byReference.get(ref);
    if (!payment) continue;
    if (consumedPayments.has(payment.id)) continue;

    if (credit.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      mismatches.push({ paymentId: payment.id, credit, reason: "currency" });
      continue;
    }
    if (credit.amountMinorUnits !== payment.amountMinorUnits) {
      mismatches.push({ paymentId: payment.id, credit, reason: "amount" });
      continue;
    }

    matches.push({ paymentId: payment.id, credit });
    consumedPayments.add(payment.id);
  }

  return { matches, mismatches };
}

// A teacher row carrying the id plus the credential columns the client
// factory needs.
// One Wise INSTRUMENT plus the teacher it belongs to. Auto-reconcile is an
// instrument capability, not a teacher one (D-113) — which is precisely why
// there is no SPEI equivalent of this module and never will be: Mexican
// retail banks expose no per-teacher statement API.
type ReconcileTeacher = TeacherWiseCreds & {
  id: string;
  instrumentId: string;
  pricingCurrency: string;
};

export type ReconcileDeps = {
  prisma: PrismaClient;
  // Builds a Wise client for one teacher from their (decrypted) creds, or
  // null when they aren't fully connected. The cron passes
  // `wiseClientForTeacher` straight through; tests pass a stub.
  clientForTeacher: (creds: TeacherWiseCreds) => WiseClient | null;
  emit?: WebhookEventEmitter;
  now?: () => Date;
  // How far back to scan for both pending payments and statement credits.
  // Defaults to 7 days, matching the abandoned-checkout cleanup window so a
  // payment can't expire out from under a still-incoming transfer.
  lookbackDays?: number;
};

export type ReconcileOutcome = {
  // True when no teacher is connected for auto-reconcile (clean no-op).
  skipped: boolean;
  teachersScanned: number;
  scannedPayments: number;
  fetchedCredits: number;
  confirmed: number;
  alreadyPaid: number;
  mismatches: number;
  // Total error count (sum of the typed counters below), kept for callers and
  // dashboards that only want a single "did anything go wrong" signal.
  errors: number;
  // Typed breakdown so operators can tell an upstream Wise/statement outage
  // (fetchErrors) from a payment-settlement bug (confirmErrors) from an
  // unexpected per-teacher failure (teacherErrors) without grepping logs.
  fetchErrors: number;
  confirmErrors: number;
  teacherErrors: number;
};

export async function reconcileWiseStatements(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const lookbackDays = deps.lookbackDays ?? 7;
  const since = new Date(now.getTime() - lookbackDays * 24 * 3600_000);

  const out: ReconcileOutcome = {
    skipped: true,
    teachersScanned: 0,
    scannedPayments: 0,
    fetchedCredits: 0,
    confirmed: 0,
    alreadyPaid: 0,
    mismatches: 0,
    errors: 0,
    fetchErrors: 0,
    confirmErrors: 0,
    teacherErrors: 0,
  };

  // Only Wise instruments that are enabled AND carry all three credential
  // columns. This is the ONE place the credential columns are read — they are
  // deliberately absent from lib/payments/instruments.ts's INSTRUMENT_SELECT
  // so no page or wire response can ship them by accident.
  const instruments = await deps.prisma.teacherPayoutInstrument.findMany({
    where: {
      kind: "wise",
      enabled: true,
      wiseApiProfileId: { not: null },
      wiseApiTokenEnc: { not: null },
      wiseApiKeyEnc: { not: null },
    },
    select: {
      id: true,
      teacherId: true,
      wiseApiProfileId: true,
      wiseApiTokenEnc: true,
      wiseApiKeyEnc: true,
      teacher: { select: { pricingCurrency: true } },
    },
  });
  const teachers: ReconcileTeacher[] = instruments.map((i) => ({
    id: i.teacherId,
    instrumentId: i.id,
    wiseApiProfileId: i.wiseApiProfileId,
    wiseApiTokenEnc: i.wiseApiTokenEnc,
    wiseApiKeyEnc: i.wiseApiKeyEnc,
    pricingCurrency: i.teacher.pricingCurrency,
  }));

  if (teachers.length === 0) return out;
  out.skipped = false;

  const ctx: TeacherCtx = {
    prisma: deps.prisma,
    clientForTeacher: deps.clientForTeacher,
    emit: deps.emit,
    nowDate: now,
    since,
  };

  // Each teacher is reconciled independently: one teacher's API failure or
  // bad creds must not abort the others.
  for (const teacher of teachers) {
    out.teachersScanned++;
    try {
      await reconcileTeacher(teacher, ctx, out);
    } catch (err) {
      out.errors++;
      out.teacherErrors++;
      log.error("teacher failed", err, { teacherId: teacher.id });
    }
  }

  return out;
}

// Per-teacher reconcile context — a resolved snapshot of the shared deps
// (fixed `nowDate`/`since`) so the loop body doesn't re-resolve them.
type TeacherCtx = {
  prisma: PrismaClient;
  clientForTeacher: ReconcileDeps["clientForTeacher"];
  emit?: WebhookEventEmitter;
  nowDate: Date;
  since: Date;
};

// Reconciles a single teacher, mutating the shared `out` accumulator. Throws
// only on unexpected errors; the statement-fetch failure is caught here so a
// flaky teacher counts as one error and the loop continues.
async function reconcileTeacher(
  teacher: ReconcileTeacher,
  ctx: TeacherCtx,
  out: ReconcileOutcome,
): Promise<void> {
  const client = ctx.clientForTeacher(teacher);
  if (!client) return; // not fully connected — skip silently

  const payments = await ctx.prisma.payment.findMany({
    where: {
      provider: "manual_transfer",
      status: "pending",
      createdAt: { gte: ctx.since },
      paymentReference: { not: null },
      package: { is: { teacherId: teacher.id } },
      // Scoped to the instrument whose statement we just read. A teacher's
      // SPEI payments must never be matched against her Wise statement — the
      // reference space is shared, so without this a SPEI payment whose
      // reference happened to appear in a Wise credit would auto-confirm.
      instrumentId: teacher.instrumentId,
    },
    select: { id: true, paymentReference: true, amountMinorUnits: true, currency: true },
    take: 1000,
  });
  out.scannedPayments += payments.length;

  // Nothing outstanding → skip the (SCA-signed, rate-limited) statement call.
  if (payments.length === 0) return;

  let credits: WiseCredit[];
  try {
    credits = await client.fetchIncomingCredits({ since: ctx.since });
  } catch (err) {
    out.errors++;
    out.fetchErrors++;
    log.error("statement fetch failed", err, { teacherId: teacher.id });
    return;
  }
  out.fetchedCredits += credits.length;

  const { matches, mismatches } = matchCredits(credits, payments);
  out.mismatches += mismatches.length;

  if (mismatches.length > 0) {
    // Reference matched but amount/currency didn't — never auto-confirm.
    // Flag loudly so the teacher (or operator) reconciles by hand.
    for (const m of mismatches) {
      log.warn("reference match with mismatch — left for manual review", {
        reason: m.reason,
        teacherId: teacher.id,
        paymentId: m.paymentId,
        creditId: m.credit.externalId,
      });
    }
  }

  for (const match of matches) {
    try {
      const outcome = await confirmTransferPayment(
        { paymentId: match.paymentId, confirmedByTeacherId: null },
        { prisma: ctx.prisma, now: () => ctx.nowDate, emit: ctx.emit },
      );
      if (outcome.code === "applied") out.confirmed++;
      else out.alreadyPaid++; // already-paid / -refunded / -failed are benign re-runs
    } catch (err) {
      out.errors++;
      out.confirmErrors++;
      log.error("confirm failed", err, { teacherId: teacher.id, paymentId: match.paymentId });
    }
  }
}
