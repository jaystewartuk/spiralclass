import { describe, expect, it } from "vitest";
import { fetchStripeClient } from "@/lib/stripe/client";

// Covers the money-movement surface of fetchStripeClient that
// tests/payments/client-retry.test.ts and tests/stripe/checkout-billing-capture.test.ts
// don't reach:
//   - getSettledCharge: reads the EXACT settled net/fee off a PaymentIntent's
//     expanded balance_transaction. Since D-143 its only caller is the
//     PLATFORM's own subscription billing (billing-webhook-handler) — the
//     teacher payout that used to read it is gone with separate charges and
//     transfers. Must return null, not throw or guess, whenever the
//     charge/balance_transaction isn't expanded yet.
//   - cancelSubscriptionAtPeriodEnd: cancel-at-period-end (no proration), the
//     documented annual-cancel policy.
//
// Same fake-fetch harness as the sibling files: inject `fetchImpl`, record the
// URL + URL-encoded body, respond with a fixed JSON payload.

function makeFetch(responseBody: object) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch) {
  return fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
}

describe("getSettledCharge", () => {
  it("reads the exact net + fee off an expanded balance_transaction", async () => {
    const { fetchImpl, calls } = makeFetch({
      id: "pi_1",
      currency: "mxn",
      latest_charge: {
        id: "ch_1",
        currency: "mxn",
        balance_transaction: {
          id: "txn_1",
          net: 189_500,
          fee: 4_500,
          currency: "mxn",
        },
      },
    });
    const settled = await client(fetchImpl).getSettledCharge("pi_1");
    expect(settled).toEqual({
      chargeId: "ch_1",
      netMinorUnits: 189_500,
      feeMinorUnits: 4_500,
      currency: "mxn",
    });
    // Requests the expand param so latest_charge.balance_transaction is
    // inlined. The SDK serializes a single-element array as expand[0]=...
    // (indexed bracket notation), not the expand[]=... form the old
    // hand-rolled client used — both are equivalent to Stripe's API.
    expect(calls[0]?.url).toContain("/v1/payment_intents/pi_1");
    expect(calls[0]?.url).toContain("expand[0]=latest_charge.balance_transaction");
  });

  it("defaults feeMinorUnits to 0 when the balance transaction omits fee", async () => {
    const { fetchImpl } = makeFetch({
      id: "pi_1",
      currency: "mxn",
      latest_charge: {
        id: "ch_1",
        currency: "mxn",
        balance_transaction: { id: "txn_1", net: 100_000, currency: "mxn" },
      },
    });
    const settled = await client(fetchImpl).getSettledCharge("pi_1");
    expect(settled?.feeMinorUnits).toBe(0);
  });

  it("URL-encodes a payment intent id with special characters", async () => {
    const { fetchImpl, calls } = makeFetch({
      id: "pi_1",
      currency: "mxn",
      latest_charge: null,
    });
    await client(fetchImpl).getSettledCharge("pi_1/weird id");
    expect(calls[0]?.url).toContain(encodeURIComponent("pi_1/weird id"));
  });

  it("returns null when there is no latest_charge yet", async () => {
    const { fetchImpl } = makeFetch({ id: "pi_1", currency: "mxn", latest_charge: null });
    expect(await client(fetchImpl).getSettledCharge("pi_1")).toBeNull();
  });

  it("returns null when latest_charge is a bare id (not expanded)", async () => {
    const { fetchImpl } = makeFetch({ id: "pi_1", currency: "mxn", latest_charge: "ch_1" });
    expect(await client(fetchImpl).getSettledCharge("pi_1")).toBeNull();
  });

  it("returns null when the charge has no balance_transaction yet (not settled)", async () => {
    const { fetchImpl } = makeFetch({
      id: "pi_1",
      currency: "mxn",
      latest_charge: { id: "ch_1", currency: "mxn", balance_transaction: null },
    });
    expect(await client(fetchImpl).getSettledCharge("pi_1")).toBeNull();
  });

  it("returns null when balance_transaction is still a bare id (not expanded)", async () => {
    const { fetchImpl } = makeFetch({
      id: "pi_1",
      currency: "mxn",
      latest_charge: { id: "ch_1", currency: "mxn", balance_transaction: "txn_1" },
    });
    expect(await client(fetchImpl).getSettledCharge("pi_1")).toBeNull();
  });
});

describe("cancelSubscriptionAtPeriodEnd", () => {
  it("sends cancel_at_period_end=true (no proration, cancel-at-end policy)", async () => {
    const { fetchImpl, calls } = makeFetch({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      cancel_at_period_end: true,
    });
    const sub = await client(fetchImpl).cancelSubscriptionAtPeriodEnd("sub_1");
    expect(sub.cancel_at_period_end).toBe(true);
    expect(calls[0]?.url).toContain("/v1/subscriptions/sub_1");
    expect(calls[0]?.body.get("cancel_at_period_end")).toBe("true");
  });
});
