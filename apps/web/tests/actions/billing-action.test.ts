import { beforeEach, describe, expect, it, vi } from "vitest";

// Subscription billing actions. startSubscriptionCheckout validates the plan,
// delegates to the billing-checkout core, and redirects to the hosted page;
// openBillingPortal redirects to the portal or back with an ?error.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const startBillingCheckout = vi.fn();
const startBillingPortal = vi.fn();
vi.mock("@/lib/subscriptions/start-billing-checkout", () => ({
  startBillingCheckout,
  startBillingPortal,
}));

// Embedded Checkout is gated on the browser publishable key being
// configured (see lib/env.ts) — mocked true here so these tests exercise
// the embedded wiring; the gate itself is covered in env.test.ts.
const hasStripeEmbeddedCheckout = vi.fn(() => true);
vi.mock("@/lib/env", () => ({ hasStripeEmbeddedCheckout: () => hasStripeEmbeddedCheckout() }));

const { startSubscriptionCheckout, openBillingPortal } = await import("@/app/actions/billing");

function planForm(plan?: string): FormData {
  const f = new FormData();
  if (plan !== undefined) f.set("plan", plan);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => vi.clearAllMocks());

describe("startSubscriptionCheckout", () => {
  it("rejects an unknown plan without calling the checkout core", async () => {
    const res = await startSubscriptionCheckout(undefined, planForm("free"));
    expect(res).toHaveProperty("error");
    expect(startBillingCheckout).not.toHaveBeenCalled();
  });

  it("redirects to the hosted checkout when the core resolves in redirect mode", async () => {
    startBillingCheckout.mockResolvedValue({
      mode: "redirect",
      redirectTo: "https://billing/checkout",
    });
    const url = await redirectOf(() => startSubscriptionCheckout(undefined, planForm("annual")));
    expect(url).toBe("https://billing/checkout");
    expect(startBillingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", plan: "annual", uiMode: "embedded" }),
    );
  });

  it("returns the client secret (no redirect) when the core resolves in embedded mode", async () => {
    startBillingCheckout.mockResolvedValue({ mode: "embedded", clientSecret: "cs_1_secret" });
    const res = await startSubscriptionCheckout(undefined, planForm("annual"));
    expect(res).toEqual({ clientSecret: "cs_1_secret" });
  });

  it("returns the core error instead of redirecting", async () => {
    startBillingCheckout.mockResolvedValue({ error: "no card on file" });
    const res = await startSubscriptionCheckout(undefined, planForm("monthly"));
    expect(res).toEqual({ error: "no card on file" });
  });

  it("requests hosted mode when the publishable key isn't configured", async () => {
    hasStripeEmbeddedCheckout.mockReturnValueOnce(false);
    startBillingCheckout.mockResolvedValue({
      mode: "redirect",
      redirectTo: "https://billing/checkout",
    });
    await redirectOf(() => startSubscriptionCheckout(undefined, planForm("annual")));
    expect(startBillingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ uiMode: "hosted" }),
    );
  });
});

describe("openBillingPortal", () => {
  it("redirects to the Stripe customer portal", async () => {
    startBillingPortal.mockResolvedValue({
      mode: "redirect",
      redirectTo: "https://billing/portal",
    });
    expect(await redirectOf(() => openBillingPortal())).toBe("https://billing/portal");
  });

  // The CODE travels back, not the sentence. The URL used to carry the whole
  // localized message ("?error=no%20subscription"), which put prose in the URL
  // bar and kept it in the language she was reading when it failed even after
  // she switched. The page translates the code on arrival now.
  it("redirects back to settings with an error CODE when the portal can't open", async () => {
    startBillingPortal.mockResolvedValue({
      error: "Todavía no tienes una suscripción que administrar.",
      code: "no-subscription",
    });
    const url = await redirectOf(() => openBillingPortal());
    expect(url).toBe("/settings/billing?error=no-subscription");
    expect(url).not.toContain("suscripci");
  });
});
