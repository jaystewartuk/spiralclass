import { describe, expect, it } from "vitest";
import {
  type ActivationSignals,
  isMarketplaceReady,
  missingMarketplaceSignals,
  resolveActivationState,
} from "./activation";

const READY: ActivationSignals = {
  onboardingComplete: true,
  hasPhoto: true,
  hasBio: true,
  templatesTouched: true,
  availabilityTouched: true,
  hasPayoutMethod: true,
  bookingCount: 0,
  hasReceivedPayment: false,
};

describe("isMarketplaceReady", () => {
  it("is true only when every sub-signal is true", () => {
    expect(isMarketplaceReady(READY)).toBe(true);
  });

  it("finishing the wizard alone is not enough (defaults untouched, no payout rail)", () => {
    const justFinishedWizard: ActivationSignals = {
      onboardingComplete: true,
      hasPhoto: false,
      hasBio: false,
      templatesTouched: false,
      availabilityTouched: false,
      hasPayoutMethod: false,
      bookingCount: 0,
      hasReceivedPayment: false,
    };
    expect(isMarketplaceReady(justFinishedWizard)).toBe(false);
  });

  it.each([
    ["onboardingComplete", false],
    ["hasPhoto", false],
    ["hasBio", false],
    ["templatesTouched", false],
    ["availabilityTouched", false],
    ["hasPayoutMethod", false],
  ] as const)("is false when %s is false", (key, value) => {
    expect(isMarketplaceReady({ ...READY, [key]: value })).toBe(false);
  });
});

describe("resolveActivationState", () => {
  it("resolves every sub-state for a fully-ready teacher", () => {
    const state = resolveActivationState(READY);
    expect(state).toMatchObject({
      baselineConfigured: true,
      profileComplete: true,
      teachingOfferCustomized: true,
      availabilityReviewed: true,
      paymentConnected: true,
      marketplaceReady: true,
      firstBookingReceived: false,
      firstPaymentReceived: false,
      activeTeacher: false,
    });
  });

  it("firstBookingReceived and activeTeacher are independent of marketplaceReady", () => {
    const state = resolveActivationState({
      ...READY,
      hasPayoutMethod: false,
      bookingCount: 3,
      hasReceivedPayment: true,
      bookingsLast30Days: 2,
    });
    expect(state.marketplaceReady).toBe(false);
    expect(state.firstBookingReceived).toBe(true);
    expect(state.firstPaymentReceived).toBe(true);
    expect(state.activeTeacher).toBe(true);
  });

  it("activeTeacher defaults to false when bookingsLast30Days is omitted", () => {
    const state = resolveActivationState(READY);
    expect(state.activeTeacher).toBe(false);
  });

  it("keeps marketplaceReady in lock-step with isMarketplaceReady", () => {
    expect(resolveActivationState(READY).marketplaceReady).toBe(isMarketplaceReady(READY));
  });
});

describe("missingMarketplaceSignals", () => {
  it("is empty exactly when the teacher is Marketplace Ready", () => {
    expect(missingMarketplaceSignals(READY)).toEqual([]);
    expect(isMarketplaceReady(READY)).toBe(true);
  });

  it("stays empty/non-empty in lock-step with isMarketplaceReady on every combination", () => {
    const keys = [
      "onboardingComplete",
      "hasPhoto",
      "hasBio",
      "templatesTouched",
      "availabilityTouched",
      "hasPayoutMethod",
    ] as const;

    // 2^6 — every possible readiness shape, so the two can't drift apart for
    // some combination nobody thought to write a case for.
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const signals = { ...READY };
      keys.forEach((key, i) => {
        signals[key] = Boolean(mask & (1 << i));
      });
      const missing = missingMarketplaceSignals(signals);
      expect(missing.length === 0).toBe(isMarketplaceReady(signals));
      // Everything reported missing really is unmet, and nothing unmet is omitted.
      expect(missing.every((key) => !signals[key])).toBe(true);
      expect(keys.filter((key) => !signals[key]).length).toBe(missing.length);
    }
  });

  it("names the two signals the growth checklist can't see (2026-07-26 de-listing)", () => {
    // The exact shape that went dark: a long-established teacher with a real
    // profile and a working payout rail, de-listed purely by the two
    // *TouchedAt columns the "Crecer" checklist has no signal for.
    expect(
      missingMarketplaceSignals({
        ...READY,
        templatesTouched: false,
        availabilityTouched: false,
      }),
    ).toEqual(["templatesTouched", "availabilityTouched"]);
  });

  it("reports in fix-order, not object-key order", () => {
    expect(
      missingMarketplaceSignals({
        ...READY,
        hasPayoutMethod: false,
        onboardingComplete: false,
        hasBio: false,
      }),
    ).toEqual(["onboardingComplete", "hasBio", "hasPayoutMethod"]);
  });
});
