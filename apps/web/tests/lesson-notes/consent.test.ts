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
});
