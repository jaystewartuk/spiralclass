import { describe, expect, it } from "vitest";
import { fetchStripeClient } from "@/lib/stripe/client";

// VAT/GST readiness (global-launch item 7) at the Stripe-request layer: both
// checkout entry points must ALWAYS collect a billing address, and must send
// `automatic_tax` ONLY when the caller opts in (stripeTaxEnabled()). The
// subscription rail additionally writes the address back onto the Customer.
//
// We inject a fake `fetchImpl` that records the URL-encoded request body so we
// can assert the exact params without touching Stripe.

function makeFetch(responseBody: object) {
  const bodies: URLSearchParams[] = [];
  const idempotencyKeys: (string | null)[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(new URLSearchParams(String(init?.body ?? "")));
    idempotencyKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, idempotencyKeys };
}

function client(fetchImpl: typeof fetch) {
  return fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
}

const CS_PAYMENT = { id: "cs_1", mode: "payment", status: "open", payment_status: "unpaid" };
const CS_SUBSCRIPTION = {
  id: "cs_2",
  mode: "subscription",
  status: "open",
  payment_status: "unpaid",
};

const lineItem = { name: "10 clases", amountMinorUnits: 150_000, currency: "mxn" as const };

describe("createCheckoutSession — billing capture + tax gating", () => {
  it("always collects a billing address and omits automatic_tax by default", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_PAYMENT);
    await client(fetchImpl).createCheckoutSession({
      connectedAccountId: "acct_teacher",
      clientReferenceId: "ref-1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
      customerEmail: "s@x.com",
      lineItem,
    });
    const body = bodies[0]!;
    expect(body.get("billing_address_collection")).toBe("required");
    expect(body.has("automatic_tax[enabled]")).toBe(false);
  });

  it("passes automatic_tax[enabled]=true only when the caller opts in", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_PAYMENT);
    await client(fetchImpl).createCheckoutSession({
      connectedAccountId: "acct_teacher",
      clientReferenceId: "ref-1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
      customerEmail: "s@x.com",
      lineItem,
      automaticTax: true,
    });
    expect(bodies[0]!.get("automatic_tax[enabled]")).toBe("true");
  });

  it("hosted mode (default) sends success_url/cancel_url, never ui_mode/return_url", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_PAYMENT);
    await client(fetchImpl).createCheckoutSession({
      connectedAccountId: "acct_teacher",
      clientReferenceId: "ref-1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
      customerEmail: "s@x.com",
      lineItem,
    });
    const body = bodies[0]!;
    expect(body.get("success_url")).toBe("https://a/s");
    expect(body.get("cancel_url")).toBe("https://a/c");
    expect(body.has("ui_mode")).toBe(false);
    expect(body.has("return_url")).toBe(false);
  });

  it("embedded mode sends ui_mode/return_url, never success_url/cancel_url", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_PAYMENT);
    await client(fetchImpl).createCheckoutSession({
      connectedAccountId: "acct_teacher",
      clientReferenceId: "ref-1",
      uiMode: "embedded",
      returnUrl: "https://a/result?session_id={CHECKOUT_SESSION_ID}",
      customerEmail: "s@x.com",
      lineItem,
    });
    const body = bodies[0]!;
    expect(body.get("ui_mode")).toBe("embedded_page");
    expect(body.get("return_url")).toBe("https://a/result?session_id={CHECKOUT_SESSION_ID}");
    expect(body.has("success_url")).toBe(false);
    expect(body.has("cancel_url")).toBe(false);
  });
});

describe("createBillingCheckoutSession — billing capture + tax gating", () => {
  it("collects the address and writes it back onto an existing Customer; tax off by default", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_m",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    });
    const body = bodies[0]!;
    expect(body.get("billing_address_collection")).toBe("required");
    expect(body.get("customer_update[address]")).toBe("auto");
    expect(body.get("customer_update[name]")).toBe("auto");
    expect(body.has("automatic_tax[enabled]")).toBe(false);
  });

  it("does NOT send customer_update when Stripe creates the Customer from email", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerEmail: "t@x.com",
      priceId: "price_m",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    });
    const body = bodies[0]!;
    expect(body.get("billing_address_collection")).toBe("required");
    expect(body.has("customer_update[address]")).toBe(false);
    expect(body.get("customer_email")).toBe("t@x.com");
  });

  it("passes automatic_tax[enabled]=true only when the caller opts in", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_m",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
      automaticTax: true,
    });
    expect(bodies[0]!.get("automatic_tax[enabled]")).toBe("true");
  });

  it("embedded mode sends ui_mode/return_url, never success_url/cancel_url", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_m",
      clientReferenceId: "t1",
      uiMode: "embedded",
      returnUrl: "https://a/settings/billing?upgraded=1",
    });
    const body = bodies[0]!;
    expect(body.get("ui_mode")).toBe("embedded_page");
    expect(body.get("return_url")).toBe("https://a/settings/billing?upgraded=1");
    expect(body.has("success_url")).toBe(false);
    expect(body.has("cancel_url")).toBe(false);
  });

  it("omits allow_promotion_codes by default", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_m",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    });
    expect(bodies[0]!.has("allow_promotion_codes")).toBe(false);
  });

  it("passes allow_promotion_codes=true only when the caller opts in", async () => {
    const { fetchImpl, bodies } = makeFetch(CS_SUBSCRIPTION);
    await client(fetchImpl).createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_m",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
      allowPromotionCodes: true,
    });
    expect(bodies[0]!.get("allow_promotion_codes")).toBe("true");
  });

  // Sentry SPIRALCLASS-2K/SPIRALCLASS-N: clientReferenceId is the teacher's own
  // stable id (not a fresh per-attempt id like the one-off checkout above), so
  // keying idempotency on it alone meant a plan switch replayed the first
  // attempt's Stripe idempotency key with different params and got rejected.
  it("varies the idempotency key by priceId, not just clientReferenceId", async () => {
    const { fetchImpl, idempotencyKeys } = makeFetch(CS_SUBSCRIPTION);
    const c = client(fetchImpl);
    await c.createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_monthly",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    });
    await c.createBillingCheckoutSession({
      customerId: "cus_1",
      priceId: "price_annual",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    });
    expect(idempotencyKeys[0]).toBeTruthy();
    expect(idempotencyKeys[1]).toBeTruthy();
    expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
  });

  it("keeps the same idempotency key across a retry with identical params (dedupes a double-submit)", async () => {
    const { fetchImpl, idempotencyKeys } = makeFetch(CS_SUBSCRIPTION);
    const c = client(fetchImpl);
    const input = {
      customerId: "cus_1",
      priceId: "price_monthly",
      connectedAccountId: "acct_teacher",
      clientReferenceId: "t1",
      successUrl: "https://a/s",
      cancelUrl: "https://a/c",
    };
    await c.createBillingCheckoutSession(input);
    await c.createBillingCheckoutSession(input);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
  });
});
