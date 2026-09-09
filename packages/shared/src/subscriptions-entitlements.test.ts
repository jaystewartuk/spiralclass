import { describe, expect, it } from "vitest";
import {
  effectiveStatus,
  entitlementsFor,
  freeEntitlements,
  type SubscriptionLike,
} from "./subscriptions-entitlements";
import {
  FREE_MAX_ACTIVE_STUDENTS,
  FREE_MAX_PACKAGE_TEMPLATES,
  PAST_DUE_GRACE_DAYS,
} from "./subscriptions-config";

// Co-located hardening for THE entitlements resolver (also guarded by the web
// wrapper's suite + the money-math mutation spot-check). Owning a test in the
// shared package means a web-side refactor that stops importing it can't leave
// this logic silently uncovered. Focus: the clock-aware effective-status
// downgrades (the resolver's whole reason to exist) and the Pro/Free/commission
// resolution.

const NOW = new Date("2026-07-17T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function sub(overrides: Partial<NonNullable<SubscriptionLike>>): SubscriptionLike {
  return {
    plan: "monthly",
    status: "active",
    comped: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
    ...overrides,
  };
}

describe("effectiveStatus — clock-aware downgrades", () => {
  it("resolves a missing subscription to free", () => {
    expect(effectiveStatus(null, NOW)).toBe("free");
  });

  it("keeps a trial that hasn't ended as trialing", () => {
    const s = sub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() + DAY) });
    expect(effectiveStatus(s, NOW)).toBe("trialing");
  });

  it("downgrades an elapsed trial to free even before the sweep flips the row", () => {
    const s = sub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - HOUR) });
    expect(effectiveStatus(s, NOW)).toBe("free");
  });

  it("downgrades a trial exactly at its boundary (<= now)", () => {
    const s = sub({ status: "trialing", trialEndsAt: new Date(NOW.getTime()) });
    expect(effectiveStatus(s, NOW)).toBe("free");
  });

  it("keeps a trialing row with no trialEndsAt as trialing (never expires it blindly)", () => {
    const s = sub({ status: "trialing", trialEndsAt: null });
    expect(effectiveStatus(s, NOW)).toBe("trialing");
  });

  it("keeps past_due inside the grace window", () => {
    const s = sub({ status: "past_due", currentPeriodEnd: new Date(NOW.getTime() - DAY) });
    expect(effectiveStatus(s, NOW)).toBe("past_due");
  });

  it("downgrades past_due once the grace window has fully elapsed", () => {
    const periodEnd = new Date(NOW.getTime() - (PAST_DUE_GRACE_DAYS + 1) * DAY);
    const s = sub({ status: "past_due", currentPeriodEnd: periodEnd });
    expect(effectiveStatus(s, NOW)).toBe("free");
  });

  it("a comped row is always effectively active regardless of underlying status", () => {
    const s = sub({ status: "canceled", comped: true });
    expect(effectiveStatus(s, NOW)).toBe("active");
  });

  it("passes canceled/active/free through unchanged", () => {
    expect(effectiveStatus(sub({ status: "canceled" }), NOW)).toBe("canceled");
    expect(effectiveStatus(sub({ status: "active" }), NOW)).toBe("active");
    expect(effectiveStatus(sub({ status: "free" }), NOW)).toBe("free");
  });
});

describe("entitlementsFor — Pro grant", () => {
  it("grants full Pro for active/trialing/past_due", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      const e = entitlementsFor(
        sub({ status, trialEndsAt: new Date(NOW.getTime() + DAY), currentPeriodEnd: NOW }),
        NOW,
      );
      expect(e.isPro).toBe(true);
      expect(e.canScheduleMaterials).toBe(true);
      expect(e.canCustomPrice).toBe(true);
      expect(e.canUseLiveNotes).toBe(true);
      expect(e.canUseIntroVideoCoach).toBe(true);
      expect(e.canUseHomeworkAiReview).toBe(true);
      expect(e.studentLimit).toBe(Number.POSITIVE_INFINITY);
      expect(e.templateLimit).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("does not grant Pro for free/canceled", () => {
    for (const status of ["free", "canceled"] as const) {
      const e = entitlementsFor(sub({ status }), NOW);
      expect(e.isPro).toBe(false);
      expect(e.canScheduleMaterials).toBe(false);
      expect(e.studentLimit).toBe(FREE_MAX_ACTIVE_STUDENTS);
      expect(e.templateLimit).toBe(FREE_MAX_PACKAGE_TEMPLATES);
    }
  });

  it("an expired trial resolves to the Free feature set", () => {
    const e = entitlementsFor(
      sub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - HOUR) }),
      NOW,
    );
    expect(e.isPro).toBe(false);
    expect(e.isTrialing).toBe(false);
    expect(e.studentLimit).toBe(FREE_MAX_ACTIVE_STUDENTS);
  });

  it("a comped teacher gets full Pro even while canceled", () => {
    const e = entitlementsFor(sub({ status: "canceled", comped: true }), NOW);
    expect(e.isPro).toBe(true);
    expect(e.comped).toBe(true);
  });

  it("surfaces the trialing/past_due banner flags", () => {
    const trial = entitlementsFor(
      sub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() + DAY) }),
      NOW,
    );
    expect(trial.isTrialing).toBe(true);
    expect(trial.isPastDue).toBe(false);

    const pastDue = entitlementsFor(sub({ status: "past_due", currentPeriodEnd: NOW }), NOW);
    expect(pastDue.isPastDue).toBe(true);
    expect(pastDue.isTrialing).toBe(false);
  });
});

describe("freeEntitlements", () => {
  it("is a genuinely-Free resolution with the Free caps", () => {
    const e = freeEntitlements();
    expect(e.isPro).toBe(false);
    expect(e.plan).toBe("free");
    expect(e.status).toBe("free");
    expect(e.studentLimit).toBe(FREE_MAX_ACTIVE_STUDENTS);
    expect(e.templateLimit).toBe(FREE_MAX_PACKAGE_TEMPLATES);
  });
});
