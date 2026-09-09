import { describe, expect, it } from "vitest";
import {
  advancePayment,
  type PaymentSnapshot,
  type StripeOutcomeInput,
} from "@/lib/payments/state";
import { InvariantViolation } from "@/lib/invariant";

// A seeded package costs 1500.00 MXN = 150000 centavos.
const AMOUNT = 150_000;

function snapshot(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return {
    status: "pending",
    amountMinorUnits: AMOUNT,
    currency: "MXN",
    rail: "unknown",
    providerPaymentId: null,
    paidAt: null,
    refundedAt: null,
    ...overrides,
  };
}

function succeeded(
  overrides: Partial<Extract<StripeOutcomeInput, { kind: "succeeded" }>> = {},
): StripeOutcomeInput {
  return {
    kind: "succeeded",
    paymentIntentId: "pi_TEST_1",
    amountReceivedMinorUnits: AMOUNT,
    currency: "mxn",
    rail: "card",
    ...overrides,
  };
}

const NOW = new Date("2026-04-24T12:00:00Z");

describe("advancePayment (Stripe)", () => {
  describe("pending → paid", () => {
    it("flips pending to paid on full-amount succeeded (card)", () => {
      const result = advancePayment(snapshot(), succeeded(), NOW);
      expect(result.action).toBe("flip-paid");
      if (result.action !== "flip-paid") throw new Error();
      expect(result.next.status).toBe("paid");
      expect(result.next.paidAt).toEqual(NOW);
      expect(result.next.rail).toBe("card");
      expect(result.next.providerPaymentId).toBe("pi_TEST_1");
      expect(result.sideEffects.activatePackage).toBe(true);
      expect(result.sideEffects.notify).toBe("payment_received");
    });

    it("flips pending to paid even if amount_received slightly exceeds expected (FX rounding)", () => {
      const result = advancePayment(
        snapshot(),
        succeeded({ amountReceivedMinorUnits: AMOUNT + 5 }),
        NOW,
      );
      expect(result.action).toBe("flip-paid");
    });
  });

  describe("pending → failed (charge-or-fail; no underpayment branch)", () => {
    it("flips pending to failed on a failed outcome", () => {
      const result = advancePayment(
        snapshot(),
        { kind: "failed", paymentIntentId: "pi_TEST_FAIL", rail: "card" },
        NOW,
      );
      expect(result.action).toBe("flip-failed");
      if (result.action !== "flip-failed") throw new Error();
      expect(result.next.status).toBe("failed");
      expect(result.next.providerPaymentId).toBe("pi_TEST_FAIL");
    });

    it("treats short-amount-received as failed (data-integrity guard; Stripe shouldn't send this but we won't activate on partial)", () => {
      const result = advancePayment(
        snapshot(),
        succeeded({ amountReceivedMinorUnits: AMOUNT - 1000 }),
        NOW,
      );
      expect(result.action).toBe("flip-failed");
    });

    it("treats a non-MXN settlement as failed (currency-mismatch guard; never activate on a different currency)", () => {
      // Same nominal amount, wrong currency — must NOT flip-paid.
      const result = advancePayment(snapshot(), succeeded({ currency: "usd" }), NOW);
      expect(result.action).toBe("flip-failed");
      if (result.action !== "flip-failed") throw new Error();
      expect(result.next.status).toBe("failed");
    });

    it("accepts an uppercased MXN currency (case-insensitive match)", () => {
      const result = advancePayment(snapshot(), succeeded({ currency: "MXN" }), NOW);
      expect(result.action).toBe("flip-paid");
    });

    it("validates against the payment's OWN currency, not a global const", () => {
      // A payment priced in USD settles in USD → flip-paid (the guard is no
      // longer hardcoded to mxn).
      const usdPaid = advancePayment(
        snapshot({ currency: "USD" }),
        succeeded({ currency: "usd" }),
        NOW,
      );
      expect(usdPaid.action).toBe("flip-paid");

      // ...and an MXN settlement against that USD payment is the mismatch now.
      const mismatch = advancePayment(
        snapshot({ currency: "USD" }),
        succeeded({ currency: "mxn" }),
        NOW,
      );
      expect(mismatch.action).toBe("flip-failed");
    });

    it("ignores a late `failed` event after the payment is already paid", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        { kind: "failed", paymentIntentId: "pi_TEST_1", rail: "card" },
        NOW,
      );
      expect(result.action).toBe("noop");
    });
  });

  describe("refunded", () => {
    it("flips paid to refunded and signals refundPackage", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        { kind: "refunded", paymentIntentId: "pi_TEST_1" },
        NOW,
      );
      expect(result.action).toBe("flip-refunded");
      if (result.action !== "flip-refunded") throw new Error();
      expect(result.next.refundedAt).toEqual(NOW);
      expect(result.sideEffects.refundPackage).toBe(true);
    });

    it("flips refunded even if the paid event hasn't landed yet (race)", () => {
      const result = advancePayment(
        snapshot(),
        { kind: "refunded", paymentIntentId: "pi_TEST_1" },
        NOW,
      );
      expect(result.action).toBe("flip-refunded");
      if (result.action !== "flip-refunded") throw new Error();
      expect(result.next.providerPaymentId).toBe("pi_TEST_1");
    });

    it("noops on refunded event after already-refunded (idempotent)", () => {
      const result = advancePayment(
        snapshot({ status: "refunded", providerPaymentId: "pi_TEST_1", refundedAt: NOW }),
        { kind: "refunded", paymentIntentId: "pi_TEST_1" },
        NOW,
      );
      expect(result.action).toBe("noop");
    });
  });

  describe("idempotency", () => {
    it("noops when the same payment_intent id arrives twice on a paid payment", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        succeeded({ paymentIntentId: "pi_TEST_1" }),
        NOW,
      );
      expect(result.action).toBe("noop");
    });

    it("re-applies if a different payment_intent id arrives on a paid payment (defensive)", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        succeeded({ paymentIntentId: "pi_TEST_2" }),
        NOW,
      );
      expect(result.action).toBe("flip-paid");
    });

    it("does NOT demote a paid payment to failed on a stale different-id event with a wrong currency", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        succeeded({ paymentIntentId: "pi_TEST_2", currency: "usd" }),
        NOW,
      );
      expect(result.action).toBe("noop");
    });

    it("does NOT demote a paid payment to failed on a stale different-id event that underpays", () => {
      const result = advancePayment(
        snapshot({ status: "paid", providerPaymentId: "pi_TEST_1", paidAt: NOW }),
        succeeded({ paymentIntentId: "pi_TEST_2", amountReceivedMinorUnits: AMOUNT - 1 }),
        NOW,
      );
      expect(result.action).toBe("noop");
    });
  });

  describe("invariant tripwire", () => {
    it("refuses to flip-paid when the expected amount is zero", () => {
      expect(() =>
        advancePayment(
          snapshot({ amountMinorUnits: 0 }),
          succeeded({ amountReceivedMinorUnits: 0 }),
          NOW,
        ),
      ).toThrow(InvariantViolation);
    });

    it("refuses to flip-paid when the expected amount is negative", () => {
      expect(() =>
        advancePayment(
          snapshot({ amountMinorUnits: -1 }),
          succeeded({ amountReceivedMinorUnits: -1 }),
          NOW,
        ),
      ).toThrow(InvariantViolation);
    });
  });
});
