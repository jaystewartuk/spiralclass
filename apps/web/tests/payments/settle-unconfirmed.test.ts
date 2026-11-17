import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// The replay's own behaviour is the webhook handler's, covered by its suites
// and by settle-unconfirmed.integration.test.ts against a real database. Here
// it is a spy, so these tests pin what the sweep decides and what it hands on.
vi.mock("@/lib/payments/webhook-handler", () => ({ handleStripeWebhook: vi.fn() }));
import { handleStripeWebhook } from "@/lib/payments/webhook-handler";
import {
  askStripeAboutPendingPayment,
  settleUnconfirmedStripePayments,
} from "@/lib/payments/settle-unconfirmed";
import { createStubStripeClient } from "@/lib/stripe/stub";
import type { StripeCheckoutSession } from "@/lib/stripe/types";

const replay = handleStripeWebhook as unknown as Mock;
const NOW = new Date("2026-11-16T03:00:00Z");

function session(over: Partial<StripeCheckoutSession>): StripeCheckoutSession {
  return {
    id: "cs_1",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    url: null,
    client_reference_id: "ref-1",
    payment_intent: "pi_1",
    customer: null,
    metadata: null,
    amount_total: 150_000,
    currency: "mxn",
    ...over,
  };
}

const PAYMENT = { id: "pay-1", stripeCheckoutSessionId: "cs_1", stripeAccountId: "acct_T" };

describe("askStripeAboutPendingPayment", () => {
  beforeEach(() => {
    replay.mockReset();
    replay.mockResolvedValue({
      code: "applied",
      action: "flip-paid",
      paymentId: "pay-1",
      packageId: "pkg-1",
    });
  });

  it("settles a paid session by replaying checkout.session.completed on the teacher's account", async () => {
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(session({}));
    const getCheckoutSession = vi.spyOn(stripe, "getCheckoutSession");
    const emit = vi.fn();

    const result = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => stripe,
      emit,
      now: () => NOW,
    });

    expect(result.verdict).toBe("paid");
    // D-143: the session is the teacher's, so it is retrieved on her account.
    expect(getCheckoutSession).toHaveBeenCalledWith("cs_1", "acct_T");
    expect(replay).toHaveBeenCalledTimes(1);
    const [envelope, deps] = replay.mock.calls[0]!;
    expect(envelope).toMatchObject({
      type: "checkout.session.completed",
      account: "acct_T",
      data: { object: { id: "cs_1" } },
    });
    // The same emitter the webhook route uses, so the fan-out is identical.
    expect(deps.emit).toBe(emit);
    expect(deps.stripe).toBe(stripe);
  });

  it("still reports paid when a delivery settled it first and the replay is a noop", async () => {
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(session({}));
    replay.mockResolvedValue({ code: "noop", reason: "already-transitioned" });

    const result = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => stripe,
    });

    expect(result.verdict).toBe("paid");
  });

  it("calls an expired, unpaid session abandoned without touching the row", async () => {
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(session({ status: "expired", payment_status: "unpaid" }));

    const result = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => stripe,
    });

    expect(result.verdict).toBe("abandoned");
    expect(replay).not.toHaveBeenCalled();
  });

  it.each([
    ["still open", session({ status: "open", payment_status: "unpaid" })],
    ["complete but awaiting an async transfer", session({ payment_status: "unpaid" })],
  ])("leaves a session that is %s unresolved", async (_label, s) => {
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(s);

    const result = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => stripe,
    });

    expect(result.verdict).toBe("unresolved");
    expect(replay).not.toHaveBeenCalled();
  });

  it("reads a Stripe that cannot be asked as unresolved, never as abandoned", async () => {
    const stripe = createStubStripeClient(); // no session seeded → retrieve throws

    const unknownSession = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => stripe,
    });
    const notConfigured = await askStripeAboutPendingPayment(PAYMENT, {
      prisma: {} as never,
      getStripe: () => {
        throw new Error("Stripe is not configured");
      },
    });

    expect(unknownSession.verdict).toBe("unresolved");
    expect(notConfigured.verdict).toBe("unresolved");
  });
});

describe("settleUnconfirmedStripePayments", () => {
  beforeEach(() => {
    replay.mockReset();
  });

  it("asks only about card payments still pending past the webhook retry window", async () => {
    const findMany = vi.fn(async () => []);

    await settleUnconfirmedStripePayments({
      prisma: { payment: { findMany } } as never,
      getStripe: () => createStubStripeClient(),
      now: () => NOW,
    });

    const args = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(args.where).toEqual({
      provider: "stripe",
      status: "pending",
      stripeCheckoutSessionId: { not: null },
      createdAt: { lt: new Date("2026-11-13T03:00:00Z") },
      package: { is: { status: "pending" } },
    });
  });

  it("counts each verdict, separating a sweep settlement from a webhook that won the race", async () => {
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(session({ id: "cs_paid" }));
    stripe.seedCheckoutSession(session({ id: "cs_raced" }));
    stripe.seedCheckoutSession(
      session({ id: "cs_gone", status: "expired", payment_status: "unpaid" }),
    );
    stripe.seedCheckoutSession(
      session({ id: "cs_open", status: "open", payment_status: "unpaid" }),
    );
    replay.mockImplementation(async (envelope: { data: { object: { id: string } } }) =>
      envelope.data.object.id === "cs_paid"
        ? { code: "applied", action: "flip-paid", paymentId: "p", packageId: "k" }
        : { code: "noop", reason: "already-transitioned" },
    );
    const row = (id: string) => ({
      id: `pay-${id}`,
      stripeCheckoutSessionId: id,
      package: { teacher: { stripeAccountId: "acct_T" } },
    });
    const findMany = vi.fn(async () => ["cs_paid", "cs_raced", "cs_gone", "cs_open"].map(row));

    const outcome = await settleUnconfirmedStripePayments({
      prisma: { payment: { findMany } } as never,
      getStripe: () => stripe,
      now: () => NOW,
    });

    expect(outcome).toEqual({
      scanned: 4,
      settled: 1,
      alreadySettled: 1,
      abandoned: 1,
      unresolved: 1,
    });
  });
});
