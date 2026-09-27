import { describe, expect, it } from "vitest";
import { lessonInsightsConsentOk } from "@/lib/lesson-notes/consent";

// Lesson-insights consent gate (D-22). The pure predicate that the capture
// entry point gates on: voice capture is OFF unless the consent that counts for
// this (teacher, student) pair has been recorded — guardian for a minor, the
// student's own otherwise.

const T = new Date("2026-06-25T12:00:00Z");

describe("lessonInsightsConsentOk", () => {
  it("defaults to NOT ok (no consent recorded)", () => {
    expect(
      lessonInsightsConsentOk({ isMinor: false, insightsConsentAt: null, guardianConsentAt: null }),
    ).toBe(false);
  });

  it("adult: ok once the student's own consent is recorded", () => {
    expect(
      lessonInsightsConsentOk({ isMinor: false, insightsConsentAt: T, guardianConsentAt: null }),
    ).toBe(true);
  });

  it("minor: a student's own consent is NOT sufficient — guardian's is required", () => {
    expect(
      lessonInsightsConsentOk({ isMinor: true, insightsConsentAt: T, guardianConsentAt: null }),
    ).toBe(false);
  });

  it("minor: ok once the guardian's consent is recorded", () => {
    expect(
      lessonInsightsConsentOk({ isMinor: true, insightsConsentAt: null, guardianConsentAt: T }),
    ).toBe(true);
  });

  it("adult: a stray guardian timestamp does NOT stand in for the student's consent", () => {
    expect(
      lessonInsightsConsentOk({ isMinor: false, insightsConsentAt: null, guardianConsentAt: T }),
    ).toBe(false);
  });

  // D-188: the second person in a class for two has no account and no consent
  // row. The buyer's confirmation at purchase is what stands in for it.
  describe("a class paid from a package for two", () => {
    const adult = { isMinor: false, insightsConsentAt: T, guardianConsentAt: null };

    it("is ok once the buyer confirmed for the second person", () => {
      expect(
        lessonInsightsConsentOk({ ...adult, classPackage: { seats: 2, partnerConsentAt: T } }),
      ).toBe(true);
    });

    it("is NOT ok without that confirmation, even with the buyer's own consent", () => {
      // A package for two recorded by the teacher, not bought: nobody confirmed.
      expect(
        lessonInsightsConsentOk({ ...adult, classPackage: { seats: 2, partnerConsentAt: null } }),
      ).toBe(false);
    });

    it("does not stand in for the buyer's own consent", () => {
      expect(
        lessonInsightsConsentOk({
          ...adult,
          insightsConsentAt: null,
          classPackage: { seats: 2, partnerConsentAt: T },
        }),
      ).toBe(false);
    });

    it("leaves a one-person class exactly as before", () => {
      expect(
        lessonInsightsConsentOk({ ...adult, classPackage: { seats: 1, partnerConsentAt: null } }),
      ).toBe(true);
    });
  });
});
