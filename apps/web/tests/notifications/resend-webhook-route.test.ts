import { beforeEach, describe, expect, it, vi } from "vitest";

// Shell of the Resend delivery-receipt ROUTE
// (src/app/api/resend/webhook/route.ts). The mapping logic is covered in
// email-webhook.test.ts; what is pinned here is the wiring — the signature
// gate, the production misconfiguration guard, body parsing, and the retry
// contract. This endpoint is public and writes to notification rows, so the
// gate mattering is the point.

const state = {
  secret: "whsec_test" as string | undefined,
  nodeEnv: "test",
  signatureOk: true,
  handlerOutcome: { code: "applied" } as Record<string, unknown>,
  handlerThrows: false,
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    RESEND_WEBHOOK_SECRET: state.secret,
    NODE_ENV: state.nodeEnv,
  }),
}));

const verifyResendSignature = vi.fn(() =>
  state.signatureOk ? { ok: true } : { ok: false, reason: "mismatch" },
);
const handleResendWebhook = vi.fn(async () => {
  if (state.handlerThrows) throw new Error("boom");
  return state.handlerOutcome;
});
vi.mock("@/lib/notifications/email-webhook", () => ({
  verifyResendSignature,
  handleResendWebhook,
}));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  correlationIdFrom: () => "corr-1",
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/resend/webhook/route");

function req(body: string): Request {
  return new Request("https://app.test/api/resend/webhook", {
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,abc",
    },
    body,
  });
}

const validEvent = JSON.stringify({
  type: "email.delivered",
  data: { email_id: "em_1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  state.secret = "whsec_test";
  state.nodeEnv = "test";
  state.signatureOk = true;
  state.handlerOutcome = { code: "applied" };
  state.handlerThrows = false;
});

describe("POST /api/resend/webhook", () => {
  it("rejects a bad signature with 401 and never runs the handler", async () => {
    state.signatureOk = false;
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(401);
    expect(handleResendWebhook).not.toHaveBeenCalled();
  });

  it("handles a correctly signed receipt", async () => {
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(200);
    expect(handleResendWebhook).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toMatchObject({ ok: true, code: "applied" });
  });

  it("refuses to accept unsigned traffic in production", async () => {
    // A public endpoint that writes notification rows must not run open.
    state.secret = undefined;
    state.nodeEnv = "production";
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(503);
    expect(handleResendWebhook).not.toHaveBeenCalled();
  });

  it("runs without a secret outside production, for local development", async () => {
    state.secret = undefined;
    state.nodeEnv = "test";
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(200);
    expect(verifyResendSignature).not.toHaveBeenCalled();
    expect(handleResendWebhook).toHaveBeenCalledOnce();
  });

  it("200s an unparseable body so the provider stops retrying it", async () => {
    const res = await POST(req("not json") as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ code: "unparseable-body" });
    expect(handleResendWebhook).not.toHaveBeenCalled();
  });

  it("500s when the handler throws, so a transient DB error is retried", async () => {
    // The opposite choice from an unparseable body: that can never succeed,
    // this can, and losing a delivery receipt is what the route exists to stop.
    state.handlerThrows = true;
    const res = await POST(req(validEvent) as never);
    expect(res.status).toBe(500);
  });
});
