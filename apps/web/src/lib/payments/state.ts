import type { PaymentRail, PaymentStatus } from "@prisma/client";
import { invariant } from "@/lib/invariant";

// Pure reducer for the payment state machine.
//
// Stripe is charge-or-fail, so there is no underpayment branch.
// Transitions covered:
//   pending  ─(succeeded)──────────►  paid       (activate package)
//   pending  ─(failed)─────────────►  failed
//   paid     ─(refunded)───────────►  refunded   (refund package)
//   paid     ─(stale event)────────►  no-op
//   refunded ─(any event)──────────►  no-op
//
// The caller (webhook handler) is responsible for persisting the result
// and for side effects (package activation, notifications). Keeping this
// pure makes the concurrent-booking race unit-testable without a DB or a real Stripe.

export type PaymentSnapshot = {
  status: PaymentStatus;
  amountMinorUnits: number; // expected amount, set at checkout creation
  // The currency this payment was priced/charged in (ISO-4217, the Payment
  // row's `currency`). The settlement guard compares Stripe's reported currency
  // against THIS, not a global const, so a future non-MXN payment validates
  // against its own expected currency. "MXN" for every row today.
  currency: string;
  rail: PaymentRail;
  providerPaymentId: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
};

// Normalized Stripe event the handler funnels into the state machine.
// The handler synthesizes this from the raw webhook + a re-fetched
// resource so the reducer doesn't depend on Stripe schemas.
export type StripeOutcomeInput =
  | {
      kind: "succeeded";
      paymentIntentId: string;
      amountReceivedMinorUnits: number;
      // The settlement currency reported by Stripe (lowercase ISO-4217,
      // e.g. "mxn"). Validated against the expected currency below — a
      // mismatch is treated as a data-integrity failure, not a paid event.
      currency: string;
      rail: PaymentRail;
    }
  | {
      kind: "failed";
      paymentIntentId: string | null;
      rail: PaymentRail;
    }
  | {
      kind: "refunded";
      paymentIntentId: string | null;
    };

// The platform's default settlement currency (lowercase ISO-4217), used where a
// caller synthesizes an outcome with no per-row currency to hand (kept for
// back-compat). The paid-path guard below compares against the PAYMENT's own
// expected currency (`snapshot.currency`), not this const — a settlement in a
// currency other than what the row was priced in makes the amount comparison
// meaningless (50000 JPY ≠ 50000 centavos MXN), so we refuse to flip-paid on a
// mismatch.
export const EXPECTED_CURRENCY = "mxn";

export type AdvanceOutcome =
  | {
      action: "flip-paid";
      next: PaymentSnapshot;
      sideEffects: { activatePackage: true; notify: "payment_received" };
    }
  | {
      action: "flip-failed";
      next: PaymentSnapshot;
      sideEffects: { activatePackage: false; notify: null };
    }
  | {
      action: "flip-refunded";
      next: PaymentSnapshot;
      sideEffects: { activatePackage: false; notify: null; refundPackage: true };
    }
  | { action: "noop"; reason: string };

export function advancePayment(
  current: PaymentSnapshot,
  outcome: StripeOutcomeInput,
  now: Date = new Date(),
): AdvanceOutcome {
  // Terminal: never regress from refunded.
  if (current.status === "refunded") {
    return { action: "noop", reason: "already-refunded" };
  }

  if (outcome.kind === "refunded") {
    if (current.status === "paid") {
      return {
        action: "flip-refunded",
        next: { ...current, status: "refunded", refundedAt: now },
        sideEffects: { activatePackage: false, notify: null, refundPackage: true },
      };
    }
    // Refund fired before the paid event landed (race). Still record
    // refunded; the package activation never happened, so refundPackage
    // is a no-op on the current state but kept for the caller.
    return {
      action: "flip-refunded",
      next: {
        ...current,
        status: "refunded",
        providerPaymentId: current.providerPaymentId ?? outcome.paymentIntentId,
        refundedAt: now,
      },
      sideEffects: { activatePackage: false, notify: null, refundPackage: true },
    };
  }

  if (outcome.kind === "failed") {
    if (current.status === "paid") {
      return { action: "noop", reason: "ignore-failed-after-paid" };
    }
    return {
      action: "flip-failed",
      next: {
        ...current,
        status: "failed",
        rail: current.rail === "unknown" ? outcome.rail : current.rail,
        providerPaymentId: current.providerPaymentId ?? outcome.paymentIntentId,
      },
      sideEffects: { activatePackage: false, notify: null },
    };
  }

  // outcome.kind === "succeeded"
  if (current.status === "paid" && current.providerPaymentId === outcome.paymentIntentId) {
    return { action: "noop", reason: "already-paid-same-id" };
  }

  // Currency must match what this payment was priced in (its own expected
  // currency, not a global const). A mismatch makes the amount comparison below
  // meaningless, so treat it as a data-integrity failure and refuse to activate
  // the package. Should be unreachable (line items force the row's currency at
  // creation) — defense in depth.
  if (outcome.currency.toLowerCase() !== current.currency.toLowerCase()) {
    // Never *demote* an already-paid payment on a stale/duplicate event —
    // keep the paid state and ignore the anomalous currency.
    if (current.status === "paid") {
      return { action: "noop", reason: "ignore-currency-mismatch-after-paid" };
    }
    return {
      action: "flip-failed",
      next: {
        ...current,
        status: "failed",
        rail: outcome.rail,
        providerPaymentId: outcome.paymentIntentId,
      },
      sideEffects: { activatePackage: false, notify: null },
    };
  }

  // Stripe is charge-or-fail; if we got `succeeded`, the full amount
  // landed. Defensive check on amount_received still — flag underpay as
  // a data-integrity event by refusing to flip-paid (treats it as
  // failed).
  if (outcome.amountReceivedMinorUnits < current.amountMinorUnits) {
    // As above: a stale/duplicate event must not demote a paid payment.
    if (current.status === "paid") {
      return { action: "noop", reason: "ignore-underpay-after-paid" };
    }
    return {
      action: "flip-failed",
      next: {
        ...current,
        status: "failed",
        rail: outcome.rail,
        providerPaymentId: outcome.paymentIntentId,
      },
      sideEffects: { activatePackage: false, notify: null },
    };
  }

  // Tripwire: never flip-paid for a non-positive amount. A zero/negative
  // expected amount on the Payment row means a bug at checkout creation
  // leaked through; activating a package on a $0 confirmation would
  // silently issue free classes. Throw loudly so Sentry surfaces it
  // before the package gets activated downstream.
  invariant(
    current.amountMinorUnits > 0,
    "payment.flip_paid.positive_amount",
    "Refusing to flip-paid: expected amount is not positive",
    {
      amountMinorUnits: current.amountMinorUnits,
      providerPaymentId: outcome.paymentIntentId,
    },
  );

  return {
    action: "flip-paid",
    next: {
      ...current,
      status: "paid",
      rail: outcome.rail,
      providerPaymentId: outcome.paymentIntentId,
      paidAt: now,
    },
    sideEffects: { activatePackage: true, notify: "payment_received" },
  };
}
