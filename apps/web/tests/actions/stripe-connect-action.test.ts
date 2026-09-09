import { beforeEach, describe, expect, it, vi } from "vitest";

// Stripe Connect onboarding actions. startStripeConnect has a dev-stub path
// (no creds, non-production) and a real path that redirects to a Stripe
// account link; disconnect clears the flags and redirects.

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const state = {
  teacher: {
    id: "t1",
    email: "mira@x.com",
    name: "Mira",
    country: "GB",
    stripeAccountId: null as string | null,
  },
  hasCreds: true,
  nodeEnv: "production",
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => state.teacher),
}));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com", NODE_ENV: state.nodeEnv }),
  hasStripeCreds: () => state.hasCreds,
}));

const createConnectedAccount = vi.fn(
  async (_input: { email: string; country: string; businessName: string }) => ({
    id: "acct_new",
    charges_enabled: false,
    payouts_enabled: false,
  }),
);
const createAccountLink = vi.fn(async () => ({ url: "https://connect.stripe.com/setup/x" }));
const createAccountSession = vi.fn(async (input: { accountId: string }) => ({
  client_secret: `accs_secret_${input.accountId}`,
}));
// Set by the unreachable-account tests to make the predicate fire for the
// error their stubbed Stripe call throws. Defaults to false so every existing
// test keeps the old behaviour.
const stripeErrors = { accountUnreachable: false };
vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({ createConnectedAccount, createAccountLink, createAccountSession }),
  isStripeConnectNotEnabledError: () => false,
  isStripeAccountUnreachableError: () => stripeErrors.accountUnreachable,
}));

const teacherUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
// The account-id persist is a GUARDED updateMany (`where: stripeAccountId
// null`), so a concurrent request that already claimed the row cannot be
// overwritten. `count: 1` is the uncontended case: this caller won.
const teacherUpdateMany = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({ count: 1 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // findUnique backs maybeEmitMarketplaceReady's post-connect re-check
    // — null short-circuits it
    // harmlessly, matching this test's focus (the Connect account flow
    // itself, not activation).
    teacher: {
      update: teacherUpdate,
      updateMany: teacherUpdateMany,
      findUnique: async () => null,
    },
  },
}));

const { startStripeConnect, startEmbeddedConnectOnboarding, disconnectStripeConnect } =
  await import("@/app/actions/stripe-connect");

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = {
    id: "t1",
    email: "mira@x.com",
    name: "Mira",
    country: "GB",
    stripeAccountId: null,
  };
  state.hasCreds = true;
  state.nodeEnv = "production";
  stripeErrors.accountUnreachable = false;
  createAccountLink.mockResolvedValue({ url: "https://connect.stripe.com/setup/x" });
  createAccountSession.mockImplementation(async (input: { accountId: string }) => ({
    client_secret: `accs_secret_${input.accountId}`,
  }));
});

describe("startStripeConnect", () => {
  it("redirects with an error in production when Stripe creds are absent", async () => {
    state.hasCreds = false;
    expect(await redirectOf(() => startStripeConnect())).toBe(
      "/settings/payments?error=stripe-disabled",
    );
  });

  it("uses the dev stub when creds are absent outside production", async () => {
    state.hasCreds = false;
    state.nodeEnv = "development";
    expect(await redirectOf(() => startStripeConnect())).toBe("/settings/payments?connected=1");
    expect(teacherUpdate).toHaveBeenCalled();
  });

  it("creates the account and redirects to the Stripe account link", async () => {
    const url = await redirectOf(() => startStripeConnect());
    expect(createConnectedAccount).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://connect.stripe.com/setup/x");
  });

  it("passes the teacher's real country to Stripe (not a hardcoded literal)", async () => {
    // Country is immutable on a Stripe connected account, so the account must be
    // created with the teacher's actual country, not a literal.
    await redirectOf(() => startStripeConnect());
    expect(createConnectedAccount.mock.calls[0][0]).toMatchObject({ country: "GB" });
  });

  it("blocks a country Stripe refuses a merchant account for, and never mints one", async () => {
    // IN is a measured refusal, not a guess: Stripe returns "card_payments
    // capability is not supported for ... country (IN)". She falls back to the
    // manual transfer rail.
    state.teacher = { ...state.teacher, country: "IN" };
    expect(await redirectOf(() => startStripeConnect())).toBe(
      "/settings/payments?error=country-unsupported",
    );
    expect(createConnectedAccount).not.toHaveBeenCalled();
  });

  it("MINTS an account for MX and BR — reversed at D-143", async () => {
    // This file asserted the exact opposite until D-143, and the reversal is the
    // point of the change. Under separate charges and transfers a UK platform
    // could not Transfer to a MX connected account, so minting one stranded her.
    // Direct charges never transfer: the charge settles on her own account, in
    // her own country, and Stripe pays her out locally. Verified against Stripe
    // test mode for both countries.
    for (const country of ["MX", "BR"]) {
      createConnectedAccount.mockClear();
      state.teacher = { ...state.teacher, country, stripeAccountId: null };
      await redirectOf(() => startStripeConnect());
      expect(createConnectedAccount).toHaveBeenCalledTimes(1);
    }
  });

  it("reuses an existing connected account", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_existing" };
    await redirectOf(() => startStripeConnect());
    expect(createConnectedAccount).not.toHaveBeenCalled();
    expect(createAccountLink).toHaveBeenCalled();
  });
});

// startEmbeddedConnectOnboarding shares ensureConnectedAccount with
// startStripeConnect (same gating, same account-creation logic) — these
// tests focus on what differs: it returns a value instead of redirecting.
describe("startEmbeddedConnectOnboarding", () => {
  it("returns an error (not a redirect) when Stripe creds are absent in production", async () => {
    state.hasCreds = false;
    const result = await startEmbeddedConnectOnboarding();
    expect(result).toEqual({ error: "stripe-disabled" });
    expect(createAccountSession).not.toHaveBeenCalled();
  });

  it("returns connected:true for the dev-stub path (no client_secret to mint)", async () => {
    state.hasCreds = false;
    state.nodeEnv = "development";
    const result = await startEmbeddedConnectOnboarding();
    expect(result).toEqual({ connected: true });
    expect(teacherUpdate).toHaveBeenCalled();
    expect(createAccountSession).not.toHaveBeenCalled();
  });

  it("blocks a Stripe-refused country, same as startStripeConnect", async () => {
    state.teacher = { ...state.teacher, country: "IN" };
    const result = await startEmbeddedConnectOnboarding();
    expect(result).toEqual({ error: "country-unsupported" });
    expect(createConnectedAccount).not.toHaveBeenCalled();
  });

  it("creates the account (if missing) and returns an Account Session client_secret", async () => {
    const result = await startEmbeddedConnectOnboarding();
    expect(createConnectedAccount).toHaveBeenCalledTimes(1);
    expect(createAccountSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_new" }),
    );
    expect(result).toEqual({ clientSecret: "accs_secret_acct_new" });
  });

  it("reuses an existing connected account without re-creating it", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_existing" };
    const result = await startEmbeddedConnectOnboarding();
    expect(createConnectedAccount).not.toHaveBeenCalled();
    expect(result).toEqual({ clientSecret: "accs_secret_acct_existing" });
  });
});

describe("disconnectStripeConnect", () => {
  it("clears the connect flags and redirects", async () => {
    const url = await redirectOf(() => disconnectStripeConnect());
    expect(url).toBe("/settings/payments?disconnected=1");
    const data = teacherUpdate.mock.calls[0][0].data as { stripeAccountId: null };
    expect(data.stripeAccountId).toBeNull();
  });
});

// A stored stripe_account_id this platform cannot act on. Accounts v2 has no
// OAuth, so an id the platform did not create is permanently unusable (D-143,
// #946) — the real case was a teacher's own acct_1ExampleTeacher0, which 400'd
// on /v1/account_sessions and left /settings/payments wedged with an opaque
// 500 for every visit (Sentry AGENDAPROFE-31).
describe("an unreachable stored account", () => {
  const unreachable = Object.assign(new Error("No such account"), { name: "StripeApiError" });

  it("surfaces a distinct error from the embedded flow instead of throwing", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_unreachable" };
    stripeErrors.accountUnreachable = true;
    createAccountSession.mockRejectedValue(unreachable);
    expect(await startEmbeddedConnectOnboarding()).toEqual({ error: "account-unreachable" });
  });

  it("surfaces the same error from the redirect fallback", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_unreachable" };
    stripeErrors.accountUnreachable = true;
    createAccountLink.mockRejectedValue(unreachable);
    expect(await redirectOf(() => startStripeConnect())).toBe(
      "/settings/payments?error=account-unreachable",
    );
  });

  // The whole point of stopping rather than self-healing. Account creation
  // under D-143's configuration cannot be undone — Stripe refuses to delete or
  // close a `losses_collector: "stripe"` account — so a retry that "fixes" the
  // broken pointer by minting a fresh account manufactures a permanent orphan.
  // That is exactly how one teacher ended up with 24 of them (#948).
  it("never mints a replacement account, and never clears the stored id", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_unreachable" };
    stripeErrors.accountUnreachable = true;
    createAccountSession.mockRejectedValue(unreachable);
    await startEmbeddedConnectOnboarding();
    expect(createConnectedAccount).not.toHaveBeenCalled();
    expect(teacherUpdate).not.toHaveBeenCalled();
    expect(teacherUpdateMany).not.toHaveBeenCalled();
  });

  // Narrowing check: an unrelated Stripe failure must keep propagating as an
  // unhandled error so it still reaches Sentry, rather than being reported to
  // the teacher as a broken account link.
  it("rethrows a Stripe error that is not an unreachable account", async () => {
    state.teacher = { ...state.teacher, stripeAccountId: "acct_fine" };
    stripeErrors.accountUnreachable = false;
    createAccountSession.mockRejectedValue(new Error("rate limited"));
    await expect(startEmbeddedConnectOnboarding()).rejects.toThrow("rate limited");
  });
});
