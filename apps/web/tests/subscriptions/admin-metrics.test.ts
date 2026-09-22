import { beforeEach, describe, expect, it, vi } from "vitest";

// getSubscriptionOverview is the admin MRR/headcount read model. The MRR math
// is the part that must not drift: only actively-billed, non-comped paid plans
// count, annual is /12, comped contributes nothing, and trials are flagged
// only inside the TRIAL_ENDING_NOTICE_DAYS (3) window.

type Sub = {
  plan: "free" | "monthly" | "annual" | "founding";
  status: "free" | "trialing" | "active" | "past_due" | "canceled";
  comped: boolean;
  trialEndsAt: Date | null;
  lockedPriceMinorUnits?: number | null;
  currency?: string;
};

function sub(over: Sub): Sub {
  return { lockedPriceMinorUnits: null, currency: "GBP", ...over };
}

const state = { subs: [] as Sub[] };
const renewalState = {
  subs: [] as Array<{
    teacherId: string;
    plan: string;
    lockedPriceMinorUnits: number | null;
    currentPeriodEnd: Date | null;
    teacher: { name: string; email: string };
  }>,
  invoices: [] as Array<{ teacherId: string; provider: string }>,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // D-113: the payout-instrument delegate. Empty by default — a test that
    // cares about a specific instrument overrides it.
    teacherPayoutInstrument: {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      count: async () => 0,
      upsert: async () => ({
        kind: "wise",
        enabled: false,
        wiseHandle: null,
        schemeId: null,
        details: null,
      }),
      updateMany: async () => ({ count: 0 }),
    },
    teacherSubscription: {
      findMany: vi.fn(async (args: { where?: { currentPeriodEnd?: unknown } }) =>
        // The renewals query filters on currentPeriodEnd; the overview query
        // doesn't. Route to the right fixture without over-fitting the shape.
        args?.where && "currentPeriodEnd" in args.where ? renewalState.subs : state.subs,
      ),
    },
    subscriptionInvoice: {
      findMany: vi.fn(async () => renewalState.invoices),
    },
  },
}));

vi.mock("@/lib/subscriptions/service", () => ({
  getFoundingCohortState: vi.fn(async () => ({
    headcount: 1,
    cap: 50,
    cutoffAt: new Date("2026-12-31"),
    isOpen: true,
  })),
}));

const { getSubscriptionOverview, getWiseRenewalsDue } =
  await import("@/lib/subscriptions/admin-metrics");

const NOW = new Date("2026-06-12T00:00:00Z");
const within3d = new Date(NOW.getTime() + 1 * 24 * 60 * 60 * 1000);
const beyond3d = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);

beforeEach(() => {
  state.subs = [];
  renewalState.subs = [];
  renewalState.invoices = [];
});

describe("getSubscriptionOverview", () => {
  it("aggregates plan/status counts and MRR across the population", async () => {
    state.subs = [
      sub({ plan: "monthly", status: "active", comped: false, trialEndsAt: null }),
      sub({ plan: "annual", status: "active", comped: false, trialEndsAt: null }),
      sub({ plan: "founding", status: "active", comped: false, trialEndsAt: null }),
      sub({ plan: "monthly", status: "active", comped: true, trialEndsAt: null }), // comped → no MRR
      sub({ plan: "monthly", status: "past_due", comped: false, trialEndsAt: null }), // still billed
      sub({ plan: "free", status: "free", comped: false, trialEndsAt: null }),
      sub({ plan: "monthly", status: "trialing", comped: false, trialEndsAt: within3d }),
      sub({ plan: "monthly", status: "canceled", comped: false, trialEndsAt: null }),
    ];

    const o = await getSubscriptionOverview(NOW);

    // MRR: 799 (monthly) + 666 (annual 7990/12, rounded) + 599 (founding) + 799
    // (past_due monthly). Comped + trialing + canceled contribute nothing.
    expect(o.mrrMinorUnits).toBe(799 + 666 + 599 + 799);
    expect(o.mrrOtherCurrencyMinorUnits).toEqual({});
    expect(o.byPlan).toEqual({ free: 1, monthly: 5, annual: 1, founding: 1 });
    expect(o.byStatus).toEqual({
      trialing: 1,
      active: 4,
      past_due: 1,
      canceled: 1,
      free: 1,
    });
    expect(o.paidCount).toBe(7); // monthly 5 + annual 1 + founding 1
    expect(o.compedCount).toBe(1);
    expect(o.trialingCount).toBe(1);
    expect(o.pastDueCount).toBe(1);
    expect(o.freeCount).toBe(1);
    expect(o.trialsEndingSoon).toBe(1);
    expect(o.founding.isOpen).toBe(true);
  });

  it("does not flag a trial ending beyond the notice window", async () => {
    state.subs = [
      sub({ plan: "monthly", status: "trialing", comped: false, trialEndsAt: beyond3d }),
    ];
    const o = await getSubscriptionOverview(NOW);
    expect(o.trialsEndingSoon).toBe(0);
    expect(o.trialingCount).toBe(1);
  });

  it("returns an all-zero overview for an empty population", async () => {
    const o = await getSubscriptionOverview(NOW);
    expect(o.mrrMinorUnits).toBe(0);
    expect(o.mrrOtherCurrencyMinorUnits).toEqual({});
    expect(o.paidCount).toBe(0);
    expect(o.byPlan).toEqual({ free: 0, monthly: 0, annual: 0, founding: 0 });
  });

  // D-99: a not-yet-renewed pre-existing MXN subscriber must contribute to
  // mrrOtherCurrencyMinorUnits, never get silently summed into the canonical GBP
  // mrrMinorUnits as if it were the same unit.
  it("keeps a legacy non-canonical-currency subscriber's MRR out of mrrMinorUnits", async () => {
    state.subs = [
      sub({ plan: "monthly", status: "active", comped: false, trialEndsAt: null }), // GBP, canonical
      sub({
        plan: "monthly",
        status: "active",
        comped: false,
        trialEndsAt: null,
        currency: "MXN",
        lockedPriceMinorUnits: 19_900,
      }),
    ];
    const o = await getSubscriptionOverview(NOW);
    expect(o.mrrMinorUnits).toBe(799);
    expect(o.mrrOtherCurrencyMinorUnits).toEqual({ MXN: 19_900 });
  });

  // A row's own persisted lockedPriceMinorUnits wins over the config table —
  // e.g. a founding member's price-locked-for-life price never re-derives
  // from what founding costs new signups today.
  it("uses a subscriber's own locked price over the config table", async () => {
    state.subs = [
      sub({
        plan: "founding",
        status: "active",
        comped: false,
        trialEndsAt: null,
        lockedPriceMinorUnits: 450, // a hypothetical older/different founding price
      }),
    ];
    const o = await getSubscriptionOverview(NOW);
    expect(o.mrrMinorUnits).toBe(450);
  });
});

// getWiseRenewalsDue — the admin worklist for the manual/Wise subscription
// rail (no automated reconciliation, so this surfaces who to chase).
describe("getWiseRenewalsDue", () => {
  const dueSoon = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
  const overdue = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

  it("includes only teachers whose latest invoice was billed via Wise", async () => {
    renewalState.subs = [
      {
        teacherId: "wise-teacher",
        plan: "monthly",
        lockedPriceMinorUnits: 19_900,
        currentPeriodEnd: dueSoon,
        teacher: { name: "Mira", email: "mira@x.com" },
      },
      {
        teacherId: "stripe-teacher",
        plan: "monthly",
        lockedPriceMinorUnits: 19_900,
        currentPeriodEnd: dueSoon,
        teacher: { name: "Beto", email: "beto@x.com" },
      },
    ];
    renewalState.invoices = [
      // Newest first — the query keeps only the first row seen per teacher.
      { teacherId: "wise-teacher", provider: "manual" },
      { teacherId: "stripe-teacher", provider: "stripe" },
    ];

    const due = await getWiseRenewalsDue(NOW);
    expect(due).toHaveLength(1);
    expect(due[0].teacherId).toBe("wise-teacher");
  });

  it("uses the most recent invoice, not an older Wise one, to decide the rail", async () => {
    renewalState.subs = [
      {
        teacherId: "switched-teacher",
        plan: "monthly",
        lockedPriceMinorUnits: 19_900,
        currentPeriodEnd: dueSoon,
        teacher: { name: "Caro", email: "caro@x.com" },
      },
    ];
    // Newest first: most recent invoice is stripe, so this teacher is excluded
    // even though an older invoice was wise.
    renewalState.invoices = [
      { teacherId: "switched-teacher", provider: "stripe" },
      { teacherId: "switched-teacher", provider: "manual" },
    ];

    const due = await getWiseRenewalsDue(NOW);
    expect(due).toHaveLength(0);
  });

  it("flags a lapsed period end as overdue and sorts soonest-first", async () => {
    renewalState.subs = [
      {
        teacherId: "b-teacher",
        plan: "monthly",
        lockedPriceMinorUnits: 19_900,
        currentPeriodEnd: dueSoon,
        teacher: { name: "Beto", email: "beto@x.com" },
      },
      {
        teacherId: "a-teacher",
        plan: "annual",
        lockedPriceMinorUnits: 199_000,
        currentPeriodEnd: overdue,
        teacher: { name: "Mira", email: "mira@x.com" },
      },
    ];
    renewalState.invoices = [
      { teacherId: "b-teacher", provider: "manual" },
      { teacherId: "a-teacher", provider: "manual" },
    ];

    const due = await getWiseRenewalsDue(NOW);
    expect(due.map((d) => d.teacherId)).toEqual(["a-teacher", "b-teacher"]);
    expect(due[0].overdue).toBe(true);
    expect(due[1].overdue).toBe(false);
  });

  it("returns an empty list when nothing is due", async () => {
    expect(await getWiseRenewalsDue(NOW)).toEqual([]);
  });
});
