import { beforeEach, describe, expect, it, vi } from "vitest";

// Shell of the Stripe Connect onboarding-return ROUTE (the teacher lands here
// after onboarding), previously 0% covered. Pins: the missing-account and
// unknown-account error redirects, the charges/payouts mirror onto the teacher
// row, the connected=1 success redirect, and the soft refetch-failure redirect.

const state = {
  teacher: { id: "t1" } as { id: string } | null,
  account: {
    charges_enabled: true,
    payouts_enabled: true,
    requirements: undefined as { disabled_reason?: string | null } | undefined,
  },
  refetchThrows: false,
};

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://app.test/" }) }));

const getConnectedAccount = vi.fn(async () => {
  if (state.refetchThrows) throw new Error("stripe down");
  return state.account;
});
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ getConnectedAccount }) }));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  correlationIdFrom: () => "corr-1",
}));

const teacherFindFirst = vi.fn(async () => state.teacher);
const teacherUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findFirst: teacherFindFirst,
      update: teacherUpdate,
      // Backs maybeEmitMarketplaceReady's post-return re-check (onboarding
      // activation audit) — null short-circuits it harmlessly,
      // matching this test's focus (the return route's own redirect logic).
      findUnique: async () => null,
    },
  },
}));

const { GET } = await import("@/app/api/stripe/connect/return/route");

function req(query: string): Request {
  return new Request(`https://app.test/api/stripe/connect/return${query}`, { method: "GET" });
}

function locationOf(res: Response): URL {
  return new URL(res.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = { id: "t1" };
  state.account = { charges_enabled: true, payouts_enabled: true, requirements: undefined };
  state.refetchThrows = false;
});

describe("GET /api/stripe/connect/return", () => {
  it("redirects with missing-account when no account param is present", async () => {
    const res = await GET(req("") as never);
    expect(locationOf(res).searchParams.get("error")).toBe("missing-account");
    expect(teacherFindFirst).not.toHaveBeenCalled();
  });

  it("redirects with unknown-account for an account not linked to a teacher", async () => {
    state.teacher = null;
    const res = await GET(req("?account=acct_x") as never);
    expect(locationOf(res).searchParams.get("error")).toBe("unknown-account");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("mirrors charges/payouts/requirements onto the teacher and redirects connected=1", async () => {
    state.account = { charges_enabled: true, payouts_enabled: false, requirements: undefined };
    const res = await GET(req("?account=acct_1") as never);
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1" },
        data: {
          stripeChargesEnabled: true,
          stripePayoutsEnabled: false,
          stripeRequirementsDisabledReason: null,
        },
      }),
    );
    const loc = locationOf(res);
    expect(loc.pathname).toBe("/settings/payments");
    expect(loc.searchParams.get("connected")).toBe("1");
  });

  it("mirrors Stripe's disabled_reason onto the teacher when present", async () => {
    state.account = {
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { disabled_reason: "requirements.past_due" },
    };
    await GET(req("?account=acct_1") as never);
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeRequirementsDisabledReason: "requirements.past_due",
        }),
      }),
    );
  });

  it("soft-fails with a refetch error redirect when Stripe is unreachable", async () => {
    state.refetchThrows = true;
    const res = await GET(req("?account=acct_1") as never);
    expect(locationOf(res).searchParams.get("error")).toBe("refetch");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  describe("refresh=1 (abandoned/expired Account Link)", () => {
    it("redirects incomplete=1 (not connected=1) when the re-fetch still isn't charge-ready", async () => {
      state.account = { charges_enabled: false, payouts_enabled: false, requirements: undefined };
      const res = await GET(req("?account=acct_1&refresh=1") as never);
      const loc = locationOf(res);
      expect(loc.searchParams.get("incomplete")).toBe("1");
      expect(loc.searchParams.get("connected")).toBeNull();
    });

    it("still redirects connected=1 if the re-fetch shows the teacher actually finished elsewhere", async () => {
      state.account = { charges_enabled: true, payouts_enabled: true, requirements: undefined };
      const res = await GET(req("?account=acct_1&refresh=1") as never);
      const loc = locationOf(res);
      expect(loc.searchParams.get("connected")).toBe("1");
      expect(loc.searchParams.get("incomplete")).toBeNull();
    });
  });
});
