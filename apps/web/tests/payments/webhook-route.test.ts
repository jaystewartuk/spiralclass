import { beforeEach, describe, expect, it, vi } from "vitest";

// Shell of the Connect Stripe webhook ROUTE (src/app/api/stripe/webhook/route.ts),
// previously 0% covered — the handler LOGIC is tested in webhook.unit/integration,
// but the route wiring (signature gate, prod-misconfig guard, body parse,
// idempotency claim/release, dispatch, analytics drain) was not. This pins each
// of those branches.

const state = {
  secret: "whsec_platform" as string | undefined,
  connectSecret: "whsec_connect" as string | undefined,
  // Which secret the fake verifier accepts. `null` = accept none.
  acceptsSecret: "whsec_platform" as string | null,
  nodeEnv: "test",
  signatureOk: true,
  claimStatus: "claimed" as "claimed" | "processed" | "in_flight",
  handlerOutcome: { code: "ok" } as Record<string, unknown>,
  handlerThrows: false,
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    STRIPE_WEBHOOK_SECRET: state.secret,
    STRIPE_CONNECT_WEBHOOK_SECRET: state.connectSecret,
    NODE_ENV: state.nodeEnv,
    APP_URL: "https://app.test",
  }),
}));

// Mirrors the real verifier: a signature matches exactly ONE secret. The route
// tries each configured secret, so the fake accepts only `state.acceptsSecret`.
const verifyWebhookSignature = vi.fn(({ secret }: { secret: string }) =>
  state.signatureOk && secret === state.acceptsSecret
    ? { ok: true }
    : { ok: false, reason: "mismatch" },
);
vi.mock("@/lib/stripe/signature", () => ({ verifyWebhookSignature }));

vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ id: "stripe" }) }));

const handleStripeWebhook = vi.fn(async () => {
  if (state.handlerThrows) throw new Error("boom");
  return state.handlerOutcome;
});
vi.mock("@/lib/payments/webhook-handler", () => ({ handleStripeWebhook }));

const send = vi.fn(async () => {});
vi.mock("@/lib/inngest/client", () => ({ inngest: { send } }));

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

const { POST } = await import("@/app/api/stripe/webhook/route");

function webhookReq(body: string, sig = "t=1,v1=abc"): Request {
  return new Request("https://app.test/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": sig },
    body,
  });
}

const validEvent = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

beforeEach(() => {
  vi.clearAllMocks();
  state.secret = "whsec_platform";
  state.connectSecret = "whsec_connect";
  state.acceptsSecret = "whsec_platform";
  state.nodeEnv = "test";
  state.signatureOk = true;
  state.claimStatus = "claimed";
  state.handlerOutcome = { code: "ok" };
  state.handlerThrows = false;
});

describe("POST /api/stripe/webhook", () => {
  it("rejects a bad signature with 401 and never runs the handler", async () => {
    state.signatureOk = false;
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(401);
    expect(handleStripeWebhook).not.toHaveBeenCalled();
  });

  // TWO Stripe event destinations deliver to this one route (D-143), each with
  // its own signing secret, and both are required: her PAYMENT events come from
  // the connected-accounts destination, while the v2 account event that flips
  // charges_enabled after onboarding comes from the PLATFORM one. Verifying
  // only one 401s the other forever — and that failure is silent, because
  // nothing in the app notices events it never receives. This was live on
  // production before D-143 and stayed invisible until an unrelated dashboard
  // edit happened to fire an event.
  it("accepts an event signed with the CONNECT secret, not just the platform one", async () => {
    state.acceptsSecret = "whsec_connect";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(200);
    expect(handleStripeWebhook).toHaveBeenCalled();
  });

  it("still accepts an event signed with the PLATFORM secret", async () => {
    state.acceptsSecret = "whsec_platform";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(200);
    expect(handleStripeWebhook).toHaveBeenCalled();
  });

  it("401s when the signature matches NEITHER secret", async () => {
    state.acceptsSecret = null;
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(401);
    expect(handleStripeWebhook).not.toHaveBeenCalled();
  });

  it("works with only the connect secret configured", async () => {
    // A deploy may legitimately carry one destination's secret and not the
    // other; a missing secret must not be treated as a rejection.
    state.secret = undefined;
    state.acceptsSecret = "whsec_connect";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(200);
  });

  it("fails closed with 503 when NO webhook secret is configured in production", async () => {
    // Both destinations' secrets absent — one being present is enough to
    // verify, so the guard fires only when there is nothing to verify with.
    state.secret = undefined;
    state.connectSecret = undefined;
    state.nodeEnv = "production";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(503);
    expect(handleStripeWebhook).not.toHaveBeenCalled();
  });

  it("200s a known-skip on an unparseable body without claiming an event", async () => {
    const res = await POST(webhookReq("not json") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "unparseable-body" });
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });

  it("short-circuits a completed duplicate delivery (idempotency) without re-running", async () => {
    state.claimStatus = "processed";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "duplicate-event", eventId: "evt_1" });
    expect(handleStripeWebhook).not.toHaveBeenCalled();
  });

  // Regression (D-79): a fresh unprocessed claim held by another delivery must
  // NOT be ack'd 200 (that ends Stripe's retries and could drop the event if
  // that other attempt died) — 409 so Stripe retries later.
  it("409s (retry later) when another delivery holds an in-flight claim", async () => {
    state.claimStatus = "in_flight";
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(409);
    expect(handleStripeWebhook).not.toHaveBeenCalled();
    expect(markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(releaseWebhookEvent).not.toHaveBeenCalled();
  });

  it("claims, dispatches, drains analytics and 200s on the happy path", async () => {
    state.handlerOutcome = { code: "payment-paid" };
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "payment-paid" });
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ provider: "stripe", eventId: "evt_1" }),
    );
    expect(handleStripeWebhook).toHaveBeenCalledTimes(1);
    expect(flushAnalytics).toHaveBeenCalledTimes(1);
    // Claim marked complete so a later redelivery is a true duplicate.
    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ provider: "stripe", eventId: "evt_1" }),
    );
    expect(releaseWebhookEvent).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim and 500s when the handler throws (so Stripe retries)", async () => {
    state.handlerThrows = true;
    const res = await POST(webhookReq(validEvent) as never);
    expect(res.status).toBe(500);
    expect(releaseWebhookEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ provider: "stripe", eventId: "evt_1" }),
    );
  });
});
