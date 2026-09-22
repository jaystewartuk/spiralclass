import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { TeacherSubscription } from "@prisma/client";
import { createT, PAST_DUE_GRACE_DAYS, type SubscriptionLike } from "@spiralclass/shared";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import type { PlanUsage } from "@/lib/subscriptions/usage";
import type { BillingHistoryEntry } from "@/lib/subscriptions/invoices";

(globalThis as Record<string, unknown>).React = React;

// The billing page's three read-only sections, rendered against the REAL
// string catalog rather than a `key => key` stub: half of what this surface
// gets wrong is the words, so a test that asserts key names would have passed
// just as happily on the version that called an ending subscription's date
// "Next charge".

vi.mock("@/app/actions/billing", () => ({
  openBillingPortal: vi.fn(),
  startSubscriptionCheckout: vi.fn(),
}));

const { PlanSummary } = await import("@/app/(app)/settings/billing/plan-summary");
const { planOptions, perMonthMinorUnits, recommendedPlan } =
  await import("@/app/(app)/settings/billing/plan-options");
const { PlanScope } = await import("@/app/(app)/settings/billing/plan-scope");
const { BillingHistory } = await import("@/app/(app)/settings/billing/billing-history");

const t = createT("en");
const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY_MS);
const TZ = "Europe/London";

function subscription(over: Partial<TeacherSubscription> = {}): TeacherSubscription {
  return {
    id: "sub-row",
    teacherId: "t1",
    plan: "monthly",
    status: "active",
    lockedPriceMinorUnits: 799,
    currency: "GBP",
    stripeCustomerId: "acct_1",
    stripeSubscriptionId: "sub_1",
    trialEndsAt: null,
    currentPeriodEnd: daysFromNow(14),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    comped: false,
    billingCountry: null,
    billingAddressJson: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as TeacherSubscription;
}

function render(sub: TeacherSubscription, plansHref?: string) {
  const entitlements = entitlementsFor(sub as unknown as SubscriptionLike, NOW);
  return renderToStaticMarkup(
    React.createElement(PlanSummary, {
      subscription: sub,
      entitlements,
      locale: "en",
      timezone: TZ,
      // Mirrors what the page resolves: a portal exists for a real Stripe
      // subscription, and not for a comped account.
      hasPortal: Boolean(sub.stripeSubscriptionId) && !sub.comped,
      plansHref,
      t,
      now: NOW,
    }),
  );
}

const FREE_ROW: Partial<TeacherSubscription> = {
  plan: "free",
  status: "free",
  lockedPriceMinorUnits: null,
  currentPeriodEnd: null,
  stripeSubscriptionId: null,
};

describe("PlanSummary", () => {
  it("calls a renewal a renewal, and quotes her own locked price", () => {
    const html = render(subscription());
    expect(html).toContain("Renews September 15, 2026");
    expect(html).toContain("£7.99 GBP");
    expect(html).toContain("per month");
    expect(html).toContain("Manage billing");
  });

  // THE regression. A Customer Portal cancellation leaves the subscription
  // `active` with the same period end, so every field the old page read still
  // said "renewing" — and it announced a charge to the one teacher who had
  // just made sure there would not be one.
  it("calls an ending subscription an ending, never a next charge", () => {
    const html = render(subscription({ cancelAtPeriodEnd: true }));
    expect(html).toContain("Ends September 15, 2026");
    expect(html).not.toContain("Renews");
    expect(html).toContain("won&#x27;t be charged again");
    // ...and the portal button offers the way back rather than a second exit.
    expect(html).toContain("Resume subscription");
  });

  it("counts a trial down with a real plural, not 'day(s)'", () => {
    const one = render(
      subscription({
        plan: "free",
        status: "trialing",
        lockedPriceMinorUnits: null,
        currentPeriodEnd: null,
        trialEndsAt: daysFromNow(0.5),
      }),
    );
    expect(one).toContain("1 day left in your free trial");
    expect(one).not.toContain("day(s)");

    const many = render(
      subscription({
        plan: "free",
        status: "trialing",
        lockedPriceMinorUnits: null,
        currentPeriodEnd: null,
        trialEndsAt: daysFromNow(9),
      }),
    );
    expect(many).toContain("9 days left in your free trial");
  });

  it("dates a failed payment at the end of the grace window and points at the card", () => {
    const html = render(subscription({ status: "past_due", currentPeriodEnd: daysFromNow(-2) }));
    expect(html).toContain("Your last payment failed");
    expect(html).toContain("Update payment method");
    // Dated at the END of the grace window (period end + PAST_DUE_GRACE_DAYS),
    // not at the period end itself — she is still Pro for those days.
    expect(html).toContain(
      new Intl.DateTimeFormat("en", {
        timeZone: TZ,
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(daysFromNow(PAST_DUE_GRACE_DAYS - 2)),
    );
  });

  // A past_due row with no period end has no date to quote, which used to fall
  // through to the reassuring "the Free plan doesn't expire".
  it("still reads as urgent when a failed payment has no date to quote", () => {
    const html = render(subscription({ status: "past_due", currentPeriodEnd: null }));
    expect(html).toContain("Your last payment failed");
    expect(html).not.toContain("doesn&#x27;t expire");
  });

  it("says a comped account is never billed, and offers it no portal", () => {
    const html = render(subscription({ comped: true }));
    expect(html).toContain("Comped");
    expect(html).toContain("never billed");
    expect(html).not.toContain("Manage billing");
    expect(html).not.toContain("Renews");
  });

  it("shows Free as costing nothing and expiring never", () => {
    const html = render(subscription(FREE_ROW));
    expect(html).toContain("No charge");
    expect(html).toContain("No payments scheduled");
  });

  // A Free teacher has no portal, so this card used to end with no action at
  // all — the one card she actually reads told her she was capped and offered
  // nothing to do about it.
  it("gives the card a way out when the page is offering plans", () => {
    const html = render(subscription(FREE_ROW), "#plans");
    expect(html).toContain("See plans");
    expect(html).toContain('href="#plans"');
  });

  it("offers no plans link when the page is not rendering plans", () => {
    expect(render(subscription(FREE_ROW))).not.toContain("See plans");
    // ...and a paying teacher keeps the portal as her only route.
    const paying = render(subscription());
    expect(paying).not.toContain("See plans");
    expect(paying).toContain("Manage billing");
  });
});

const COHORT_CLOSED = { isOpen: false, headcount: 25, cap: 25, cutoffAt: daysFromNow(30) };
const COHORT_OPEN = { ...COHORT_CLOSED, isOpen: true, headcount: 22 };

describe("planOptions", () => {
  const options = (cohort: typeof COHORT_CLOSED) =>
    planOptions({ t, locale: "en", cohort, timezone: TZ });

  // Three cards of identical weight with three identical primary buttons hand
  // the reader a comparison the price table already answers. Which one leads
  // is DERIVED from that table, so it cannot outlive a price change.
  it("recommends exactly one plan, and it is the cheapest per month", () => {
    const closed = options(COHORT_CLOSED);
    expect(closed.filter((o) => o.recommended).map((o) => o.plan)).toEqual(["annual"]);
    expect(perMonthMinorUnits("annual")).toBeLessThan(perMonthMinorUnits("monthly"));

    const open = options(COHORT_OPEN);
    expect(open.filter((o) => o.recommended).map((o) => o.plan)).toEqual(["founding"]);
    expect(perMonthMinorUnits("founding")).toBeLessThan(perMonthMinorUnits("annual"));
  });

  it("recommends nothing rather than lying when no plan undercuts monthly", () => {
    // The guard, stated as its own case: `recommendedPlan` is the only thing
    // between a changed price table and a "Best value" badge on the dearest
    // card, and it answers from the table rather than from a constant.
    expect(recommendedPlan(false)).toBe("annual");
    expect(recommendedPlan(true)).toBe("founding");
  });

  it("expresses the annual price per month, in the platform currency", () => {
    const annual = options(COHORT_CLOSED).find((o) => o.plan === "annual");
    expect(annual?.priceLabel).toBe("£79.90 GBP");
    // The currency code rides along, exactly as it does in the already-shipped
    // saving line beneath it — `formatMinorUnits` appends it so a "$" is never
    // ambiguous, and one price on this page spelling it differently would be
    // worse than the slight clumsiness mid-sentence.
    expect(annual?.equivalentLabel).toBe("Works out at £6.66 GBP a month");
    expect(annual?.highlight).toBe("Save £15.98 GBP a year");
    // Monthly is already a monthly figure — restating it would be noise.
    expect(
      options(COHORT_CLOSED).find((o) => o.plan === "monthly")?.equivalentLabel,
    ).toBeUndefined();
  });

  it("offers founding only while the cohort is open, with a real count", () => {
    expect(options(COHORT_CLOSED).map((o) => o.plan)).toEqual(["monthly", "annual"]);
    const founding = options(COHORT_OPEN).find((o) => o.plan === "founding");
    expect(founding?.highlight).toBe("3 spots left");
    expect(founding?.footnote).toContain("Closes");
  });
});

function usage(over: Partial<PlanUsage> = {}): PlanUsage {
  return {
    students: { used: 2, limit: 3, overLimit: false },
    templates: { used: 1, limit: 1, overLimit: false },
    ...over,
  };
}

const FREE: SubscriptionLike = {
  plan: "free",
  status: "free",
  comped: false,
  trialEndsAt: null,
  currentPeriodEnd: null,
};

// Just the "Pro features" list, so an assertion about what Pro unlocks cannot
// be satisfied by the always-included list that sits above it.
function proGroup(html: string): string {
  const start = html.indexOf('id="scope-pro-heading"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

function renderScope(sub: SubscriptionLike, planUsage: PlanUsage) {
  return renderToStaticMarkup(
    React.createElement(PlanScope, {
      entitlements: entitlementsFor(sub, NOW),
      usage: planUsage,
      t,
    }),
  );
}

describe("PlanScope", () => {
  it("states the Free caps up front, with the meter's value exposed", () => {
    const html = renderScope(FREE, usage());
    expect(html).toContain("2 of 3");
    expect(html).toContain("1 left");
    expect(html).toContain("Limit reached");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuemax="3"');
  });

  // Downgrading never deletes anything, so this is a state a real teacher
  // lands in — and the reassurance has to travel with the number.
  it("renders a grandfathered over-cap teacher honestly", () => {
    const html = renderScope(FREE, usage({ students: { used: 7, limit: 3, overLimit: true } }));
    expect(html).toContain("7 of 3");
    expect(html).toContain("4 over your limit");
    expect(html).toContain("Nothing is ever deleted");
  });

  it("draws no meter for an unlimited grant", () => {
    const pro: SubscriptionLike = { ...FREE, plan: "monthly", status: "active" };
    const html = renderScope(pro, {
      students: { used: 41, limit: null, overLimit: false },
      templates: { used: 6, limit: null, overLimit: false },
    });
    expect(html).toContain("Unlimited");
    expect(html).toContain("41 in use");
    expect(html).not.toContain('role="progressbar"');
  });

  // The list is the plan's scope, so every capability has to be able to say
  // "not on your plan" — and the state has to reach a screen reader, which
  // cannot see that one icon is a padlock and the other a tick.
  it("marks each capability included or not, in text as well as in colour", () => {
    // Scoped to the Pro GROUP: the always-included group above it is marked
    // "Included" on every tier, so a whole-card assertion would now pass on a
    // Free render that wrongly unlocked all six Pro lines.
    const free = proGroup(renderScope(FREE, usage()));
    expect(free).toContain("Per-student custom pricing");
    expect(free).toContain("Not on your plan");
    expect(free).not.toContain("— Included");

    const pro = proGroup(renderScope({ ...FREE, plan: "annual", status: "active" }, usage()));
    expect(pro).toContain("Included");
    expect(pro).not.toContain("Not on your plan");
  });

  // The card promised to say what her plan COVERS and, on Free, listed six
  // padlocks and nothing else — every Pro entitlement is false there, so the
  // only honest half of the answer was the half it left out.
  it("names what Free includes, not only what it locks", () => {
    const html = renderScope(FREE, usage());
    expect(html).toContain("On every plan, including Free");
    expect(html).toContain("Both payment rails (card + Wise)");
    expect(html).toContain("No commission on what your students pay you");
    expect(html).toContain("Full scheduling + public booking page");
    // The always-included group is never padlocked, on any tier.
    expect(html).toContain("Pro features");
  });

  it("lists the Pro capabilities the old 'Pro unlocks' list left out", () => {
    const html = renderScope(FREE, usage());
    for (const label of [
      "Live lesson notes during class",
      "AI coaching on your intro video",
      "AI-assisted homework review",
    ]) {
      expect(html).toContain(label);
    }
  });
});

describe("BillingHistory", () => {
  const entry = (over: Partial<BillingHistoryEntry> = {}): BillingHistoryEntry => ({
    id: "inv-1",
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-09-01T00:00:00Z"),
    amountMinorUnits: 799,
    currency: "GBP",
    status: "paid",
    paidAt: new Date("2026-08-01T09:15:00Z"),
    ...over,
  });

  it("renders nothing at all rather than an empty table", () => {
    expect(
      renderToStaticMarkup(
        React.createElement(BillingHistory, {
          entries: [],
          locale: "en",
          timezone: TZ,
          hasPortal: true,
          t,
        }),
      ),
    ).toBe("");
  });

  it("shows each charge with a machine-readable date and its status", () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingHistory, {
        entries: [entry(), entry({ id: "inv-2", status: "failed", paidAt: null })],
        locale: "en",
        timezone: TZ,
        hasPortal: true,
        t,
      }),
    );
    expect(html).toContain("£7.99 GBP");
    expect(html).toContain('dateTime="2026-08-01"');
    expect(html).toContain("Paid");
    expect(html).toContain("Failed");
  });

  // A pre-D-99 subscriber was genuinely charged in MXN. Re-denominating her
  // history into the platform's current currency would invent a number she was
  // never billed.
  it("formats each charge in the currency it actually settled in", () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingHistory, {
        entries: [entry({ amountMinorUnits: 19_900, currency: "MXN" })],
        locale: "en",
        timezone: TZ,
        hasPortal: true,
        t,
      }),
    );
    expect(html).toContain("$199.00 MXN");
    expect(html).not.toContain("GBP");
  });
});
