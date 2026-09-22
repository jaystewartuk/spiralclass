import { describe, expect, it } from "vitest";
import {
  effectiveStatus,
  entitlementsFor,
  type SubscriptionLike,
} from "@/lib/subscriptions/entitlements";
import { FREE_MAX_ACTIVE_STUDENTS, FREE_MAX_PACKAGE_TEMPLATES } from "@/lib/subscriptions/config";

const NOW = new Date("2026-06-12T00:00:00Z");

function sub(partial: Partial<NonNullable<SubscriptionLike>>): NonNullable<SubscriptionLike> {
  return {
    plan: "free",
    status: "trialing",
    comped: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
    ...partial,
  };
}

describe("entitlementsFor", () => {
  it("trialing teacher gets full Pro", () => {
    const e = entitlementsFor(
      sub({ status: "trialing", trialEndsAt: new Date("2026-07-01T00:00:00Z") }),
      NOW,
    );
    expect(e.isPro).toBe(true);
    expect(e.isTrialing).toBe(true);
    expect(e.studentLimit).toBe(Number.POSITIVE_INFINITY);
    expect(e.templateLimit).toBe(Number.POSITIVE_INFINITY);
    expect(e.canScheduleMaterials).toBe(true);
    expect(e.canCustomPrice).toBe(true);
    expect(e.canUseLiveNotes).toBe(true);
    expect(e.canUseIntroVideoCoach).toBe(true);
  });

  it("active paid teacher gets full Pro", () => {
    const e = entitlementsFor(sub({ plan: "monthly", status: "active" }), NOW);
    expect(e.isPro).toBe(true);
  });

  it("past_due (in grace) keeps full Pro + the banner flag", () => {
    const e = entitlementsFor(
      sub({
        plan: "monthly",
        status: "past_due",
        currentPeriodEnd: new Date("2026-06-10T00:00:00Z"), // grace not elapsed
      }),
      NOW,
    );
    expect(e.isPro).toBe(true);
    expect(e.isPastDue).toBe(true);
  });

  it("comped teacher is always Pro regardless of status", () => {
    const e = entitlementsFor(sub({ plan: "founding", status: "free", comped: true }), NOW);
    expect(e.isPro).toBe(true);
    expect(e.comped).toBe(true);
  });

  it("free teacher gets the Free caps and no Pro features", () => {
    const e = entitlementsFor(sub({ plan: "free", status: "free" }), NOW);
    expect(e.isPro).toBe(false);
    expect(e.canScheduleMaterials).toBe(false);
    expect(e.canCustomPrice).toBe(false);
    expect(e.canUseLiveNotes).toBe(false);
    expect(e.canUseIntroVideoCoach).toBe(false);
    expect(e.studentLimit).toBe(FREE_MAX_ACTIVE_STUDENTS);
    expect(e.templateLimit).toBe(FREE_MAX_PACKAGE_TEMPLATES);
  });

  it("missing subscription row resolves to Free (never locked out)", () => {
    const e = entitlementsFor(null, NOW);
    expect(e.isPro).toBe(false);
    expect(e.plan).toBe("free");
    expect(e.studentLimit).toBe(FREE_MAX_ACTIVE_STUDENTS);
  });
});

describe("effectiveStatus (clock-aware, never grants past expiry)", () => {
  it("trialing whose trial has passed resolves to free even before the sweep", () => {
    const s = sub({ status: "trialing", trialEndsAt: new Date("2026-06-01T00:00:00Z") });
    expect(effectiveStatus(s, NOW)).toBe("free");
    expect(entitlementsFor(s, NOW).isPro).toBe(false);
  });

  it("past_due whose grace has elapsed resolves to free", () => {
    // currentPeriodEnd + 7 days < NOW.
    const s = sub({
      status: "past_due",
      currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
    });
    expect(effectiveStatus(s, NOW)).toBe("free");
    expect(entitlementsFor(s, NOW).isPro).toBe(false);
  });

  it("comped overrides the clock", () => {
    const s = sub({
      status: "trialing",
      trialEndsAt: new Date("2020-01-01T00:00:00Z"),
      comped: true,
    });
    expect(effectiveStatus(s, NOW)).toBe("active");
  });
});
