import { describe, expect, it } from "vitest";
import { bookingPageReadiness, type BookingPageReadinessInput } from "./page-readiness";

// `/b/<slug>` calls `notFound()` unless `isPubliclyListed()` passes, so the
// difference between "live" and "not live" here is the difference between a
// link that works and one that 404s for every student it is sent to. These
// assert the decomposition agrees with that gate on every axis it gates on.

const READY: BookingPageReadinessInput = {
  disabledAt: null,
  onboardingCompleteAt: new Date("2026-01-01T00:00:00.000Z"),
  photoPath: "teachers/t1/photo.jpg",
  bio: "Ten years teaching adults who freeze when they have to speak.",
  templatesTouchedAt: new Date("2026-01-02T00:00:00.000Z"),
  availabilityTouchedAt: new Date("2026-01-03T00:00:00.000Z"),
  stripeChargesEnabled: true,
  pricingCurrency: "MXN",
  payoutInstruments: [],
  headline: "Spanish for people who have to speak it on Monday",
  introVideoPath: "teachers/t1/intro.mp4",
  targetLanguage: "es",
  publicWhatsappE164: "+525512345678",
  introVideoAvailable: true,
};

const open = (input: BookingPageReadinessInput) =>
  bookingPageReadiness(input)
    .requirements.filter((r) => !r.done)
    .map((r) => r.key);

describe("bookingPageReadiness — the gate", () => {
  it("is live, complete and silent when everything is in place", () => {
    const result = bookingPageReadiness(READY);
    expect(result.live).toBe(true);
    expect(result.percent).toBe(100);
    expect(result.requirementsDone).toBe(result.requirementTotal);
    expect(open(READY)).toEqual([]);
    expect(result.suggestions.filter((s) => !s.done)).toEqual([]);
  });

  it.each([
    ["onboarding", { onboardingCompleteAt: null }],
    ["photo", { photoPath: null }],
    ["bio", { bio: null }],
    ["packages", { templatesTouchedAt: null }],
    ["availability", { availabilityTouchedAt: null }],
  ] as const)("takes the page down when %s is missing, and names it", (key, override) => {
    const input = { ...READY, ...override };
    expect(bookingPageReadiness(input).live).toBe(false);
    expect(open(input)).toEqual([key]);
  });

  it("counts whitespace as no bio — a page of spaces is not a description", () => {
    const input = { ...READY, bio: "   \n  " };
    expect(bookingPageReadiness(input).live).toBe(false);
    expect(open(input)).toEqual(["bio"]);
  });

  it("reports partial progress rather than a bare yes/no", () => {
    const input = { ...READY, photoPath: null, bio: null, templatesTouchedAt: null };
    const result = bookingPageReadiness(input);
    expect(result.requirementsDone).toBe(3);
    expect(result.requirementTotal).toBe(6);
    expect(result.percent).toBe(50);
  });

  it("stays down for a disabled account even with every requirement met", () => {
    const result = bookingPageReadiness({ ...READY, disabledAt: new Date() });
    expect(result.live).toBe(false);
    expect(result.disabled).toBe(true);
    // The requirements themselves are all met — nothing on this screen would
    // bring the page back, which is why the editor must not offer a to-do list.
    expect(result.requirementsDone).toBe(result.requirementTotal);
  });
});

describe("bookingPageReadiness — the payout rail", () => {
  const noStripe = { ...READY, stripeChargesEnabled: false };

  it("blocks a teacher with no rail at all", () => {
    expect(open({ ...noStripe, payoutInstruments: [] })).toEqual(["payouts"]);
  });

  it("accepts a ready manual instrument instead of Stripe", () => {
    const input = {
      ...noStripe,
      payoutInstruments: [{ kind: "wise" as const, enabled: true, wiseHandle: "anaprofe" }],
    };
    expect(bookingPageReadiness(input).live).toBe(true);
  });

  it("does not accept an instrument that is enabled but has no handle to pay", () => {
    const input = {
      ...noStripe,
      payoutInstruments: [{ kind: "wise" as const, enabled: true, wiseHandle: null }],
    };
    expect(open(input)).toEqual(["payouts"]);
  });

  it("does not accept a complete instrument that is switched off", () => {
    const input = {
      ...noStripe,
      payoutInstruments: [{ kind: "wise" as const, enabled: false, wiseHandle: "anaprofe" }],
    };
    expect(open(input)).toEqual(["payouts"]);
  });
});

describe("bookingPageReadiness — suggestions", () => {
  const suggested = (input: BookingPageReadinessInput) =>
    bookingPageReadiness(input)
      .suggestions.filter((s) => !s.done)
      .map((s) => s.key);

  it("never lets a suggestion take the page down", () => {
    const input = {
      ...READY,
      headline: null,
      introVideoPath: null,
      targetLanguage: null,
      publicWhatsappE164: null,
    };
    const result = bookingPageReadiness(input);
    expect(result.live).toBe(true);
    expect(result.percent).toBe(100);
    expect(suggested(input)).toEqual(["headline", "video", "targetLanguage", "whatsapp"]);
  });

  it("omits the video suggestion where video storage is not configured", () => {
    const input = { ...READY, introVideoPath: null, introVideoAvailable: false };
    expect(suggested(input)).toEqual([]);
    expect(bookingPageReadiness(input).suggestions.map((s) => s.key)).not.toContain("video");
  });
});
