import { afterEach, describe, expect, it, vi } from "vitest";

// external-links builds Stripe/Resend dashboard deep-links. Live vs.
// test mode is detected from the STRIPE_SECRET_KEY prefix, so the env is
// the only seam. Each test sets the key it needs before importing.

const env = { STRIPE_SECRET_KEY: "sk_live_abc" as string | undefined };

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
}));

const {
  stripePaymentIntentUrl,
  stripeRefundUrl,
  stripeConnectedAccountUrl,
  stripeCheckoutSessionUrl,
  resendEmailUrl,
} = await import("@/lib/external-links");

afterEach(() => {
  env.STRIPE_SECRET_KEY = "sk_live_abc";
});

describe("stripe dashboard URLs — live mode", () => {
  it("uses the live base for payment intents", () => {
    expect(stripePaymentIntentUrl("pi_123")).toBe("https://dashboard.stripe.com/payments/pi_123");
  });

  it("builds refund, account, and session URLs", () => {
    expect(stripeRefundUrl("re_1")).toBe("https://dashboard.stripe.com/refunds/re_1");
    expect(stripeConnectedAccountUrl("acct_1")).toBe(
      "https://dashboard.stripe.com/connect/accounts/acct_1",
    );
    expect(stripeCheckoutSessionUrl("cs_1")).toBe(
      "https://dashboard.stripe.com/checkout/sessions/cs_1",
    );
  });

  it("returns null for empty ids", () => {
    expect(stripePaymentIntentUrl(null)).toBeNull();
    expect(stripeRefundUrl(undefined)).toBeNull();
    expect(stripeConnectedAccountUrl("")).toBeNull();
  });
});

describe("stripe dashboard URLs — test mode", () => {
  it("inserts the /test segment when the key is sk_test_", () => {
    env.STRIPE_SECRET_KEY = "sk_test_xyz";
    expect(stripePaymentIntentUrl("pi_9")).toBe("https://dashboard.stripe.com/test/payments/pi_9");
  });

  it("treats a missing key as live (production default)", () => {
    env.STRIPE_SECRET_KEY = undefined;
    expect(stripeCheckoutSessionUrl("cs_9")).toBe(
      "https://dashboard.stripe.com/checkout/sessions/cs_9",
    );
  });
});

describe("resendEmailUrl", () => {
  it("links Resend ids that start with re_", () => {
    expect(resendEmailUrl("re_abc")).toBe("https://resend.com/emails/re_abc");
  });

  it("returns null for non-Resend ids and empties", () => {
    expect(resendEmailUrl("wamid.HBgN")).toBeNull();
    expect(resendEmailUrl(null)).toBeNull();
  });
});
