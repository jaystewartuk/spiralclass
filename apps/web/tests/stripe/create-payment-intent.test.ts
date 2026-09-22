import { describe, expect, it } from "vitest";
import { fetchStripeClient } from "@/lib/stripe/client";

// createPaymentIntent — the raw PaymentIntent path used by the mobile Stripe
// React Native SDK (PaymentSheet), which has no concept of a Checkout
// Session. Card-only, plain platform charge (no transfer_data — same
// separate-charges-and-transfers shape as createCheckoutSession).

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

describe("createPaymentIntent", () => {
  it("sends amount/currency/card-only and returns the client_secret", async () => {
    const { fetchImpl, calls } = makeFetch({
      id: "pi_1",
      status: "requires_payment_method",
      amount: 150_000,
      currency: "mxn",
      client_secret: "pi_1_secret_abc",
    });
    const intent = await client(fetchImpl).createPaymentIntent({
      amountMinorUnits: 150_000,
      currency: "mxn",
      customerEmail: "mira@example.com",
      metadata: { external_reference: "ext-ref-1" },
    });
    expect(intent.client_secret).toBe("pi_1_secret_abc");
    const body = calls[0]!.body;
    expect(body.get("amount")).toBe("150000");
    expect(body.get("currency")).toBe("mxn");
    expect(body.get("payment_method_types[0]")).toBe("card");
    expect(body.get("receipt_email")).toBe("mira@example.com");
    expect(body.get("metadata[external_reference]")).toBe("ext-ref-1");
  });

  it("omits receipt_email when no customer email is given", async () => {
    const { fetchImpl, calls } = makeFetch({
      id: "pi_2",
      status: "requires_payment_method",
      amount: 1000,
      currency: "mxn",
      client_secret: "pi_2_secret",
    });
    await client(fetchImpl).createPaymentIntent({ amountMinorUnits: 1000, currency: "mxn" });
    expect(calls[0]!.body.has("receipt_email")).toBe(false);
  });
});
