import { beforeEach, describe, expect, it, vi } from "vitest";

// Shell of the BILLING Stripe webhook ROUTE (the teacher's own subscription —
// separate endpoint + secret from Connect), previously 0% covered. The lifecycle
// handler logic is tested in subscriptions/billing-webhook; this pins the route
// wiring: the dedicated STRIPE_BILLING_WEBHOOK_SECRET signature gate, prod
// misconfig guard, idempotency claim/release, and dispatch.

const state = {
  secret: "whsec_billing" as string | undefined,
  nodeEnv: "test",
  signatureOk: true,
  claimStatus: "claimed" as "claimed" | "processed" | "in_flight",
  handlerThrows: false,
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    STRIPE_BILLING_WEBHOOK_SECRET: state.secret,
    NODE_ENV: state.nodeEnv,
    APP_URL: "https://app.test",
  }),
  billingPriceIds: () => ({ monthly: "price_m", annual: "price_a" }),
}));

const verifyWebhookSignature = vi.fn(() =>
  state.signatureOk ? { ok: true } : { ok: false, reason: "bad-sig" },
);
vi.mock("@/lib/stripe/signature", () => ({ verifyWebhookSignature }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ id: "stripe" }) }));

const handleBillingWebhook = vi.fn(async () => {
  if (state.handlerThrows) throw new Error("boom");
  return { code: "subscription-active" };
});
vi.mock("@/lib/subscriptions/billing-webhook-handler", () => ({ handleBillingWebhook }));

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn(async () => {}) } }));

const recordWebhookEvent = vi.fn(async () => ({ status: state.claimStatus }));
const releaseWebhookEvent = vi.fn(async () => {});
const markWebhookEventProcessed = vi.fn(async () => {});
vi.mock("@/lib/webhooks/idempotency", () => ({
  recordWebhookEvent,
  releaseWebhookEvent,
  markWebhookEventProcessed,
}));

const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ flushAnalytics }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  correlationIdFrom: () => "corr-1",
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/stripe/billing-webhook/route");

function req(body: string): Request {
  return new Request("https://app.test/api/stripe/billing-webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=abc" },
    body,
  });
}

const validEvent = JSON.stringify({ id: "evt_b1", type: "customer.subscription.updated" });

beforeEach(() => {
  vi.clearAllMocks();
  state.secret = "whsec_billing";
  state.nodeEnv = "test";
  state.signatureOk = true;
  state.claimStatus = "claimed";
  state.handlerThrows = false;
});

describe("POST /api/stripe/billing-webhook", () => {
  it("401s on a bad signature against the BILLING secret", async () => {
    state.signatureOk = false;
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(401);
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "whsec_billing" }),
    );
    expect(handleBillingWebhook).not.toHaveBeenCalled();
  });

  it("503s when the billing secret is missing in production", async () => {
    state.secret = undefined;
    state.nodeEnv = "production";
    expect((await POST(req(validEvent) as never)).status).toBe(503);
  });

  it("short-circuits a completed duplicate delivery", async () => {
    state.claimStatus = "processed";
    const res = await POST(req(validEvent) as never);
    expect(await res.json()).toMatchObject({ ok: true, code: "duplicate-event" });
    expect(handleBillingWebhook).not.toHaveBeenCalled();
  });

  // Regression (D-79): a fresh unprocessed claim held by another delivery → 409
  // (retry later), never a 200 that would end Stripe's retries.
  it("409s when another delivery holds an in-flight claim", async () => {
    state.claimStatus = "in_flight";
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(409);
    expect(handleBillingWebhook).not.toHaveBeenCalled();
  });

  it("dispatches the lifecycle handler and 200s on the happy path", async () => {
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "subscription-active" });
    expect(handleBillingWebhook).toHaveBeenCalledTimes(1);
    expect(flushAnalytics).toHaveBeenCalledTimes(1);
    // Claim marked complete under the namespaced id.
    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ eventId: "billing:evt_b1" }),
    );
  });

  // Regression: both Stripe endpoints share one WebhookEvent log. A Stripe event
  // id is unique only among endpoints subscribed to that TYPE, so if this billing
  // endpoint ever receives a Connect event type too, an unprefixed claim would
  // shadow the Connect endpoint's claim and drop the package payment. The billing
  // endpoint namespaces its claim with a "billing:" prefix to stay disjoint.
  it("namespaces its idempotency claim with a billing: prefix", async () => {
    await POST(req(validEvent) as never);
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ eventId: "billing:evt_b1" }),
    );
  });

  it("releases the namespaced claim and 500s when the handler throws", async () => {
    state.handlerThrows = true;
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(500);
    expect(releaseWebhookEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ eventId: "billing:evt_b1" }),
    );
  });
});
