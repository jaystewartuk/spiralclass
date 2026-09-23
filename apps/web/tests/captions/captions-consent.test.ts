import { describe, expect, it } from "vitest";
import { captionsConsentOk } from "@/lib/captions/consent";

// Live-captions consent gate (the captions architecture review
// P0). The pure predicate that decides whether a STUDENT's speech may be
// captioned at all (D-185): no browser in the call recognises it, and the
// translation route refuses it, unless the consent that counts for this
// (teacher, student) pair has been recorded — guardian for a minor, the
// student's own otherwise.
// Same shape as lessonInsightsConsentOk's test, deliberately: this is a
// separate consent record, not a reuse, but the rule is identical.

const T = new Date("2026-07-25T12:00:00Z");

describe("captionsConsentOk", () => {
  it("defaults to NOT ok (no consent recorded)", () => {
    expect(
      captionsConsentOk({
        isMinor: false,
        captionsConsentAt: null,
        captionsGuardianConsentAt: null,
      }),
    ).toBe(false);
  });

  it("adult: ok once the student's own consent is recorded", () => {
    expect(
      captionsConsentOk({ isMinor: false, captionsConsentAt: T, captionsGuardianConsentAt: null }),
    ).toBe(true);
  });

  it("minor: a student's own consent is NOT sufficient — guardian's is required", () => {
    expect(
      captionsConsentOk({ isMinor: true, captionsConsentAt: T, captionsGuardianConsentAt: null }),
    ).toBe(false);
  });

  it("minor: ok once the guardian's consent is recorded", () => {
    expect(
      captionsConsentOk({ isMinor: true, captionsConsentAt: null, captionsGuardianConsentAt: T }),
    ).toBe(true);
  });

  it("adult: a stray guardian timestamp does NOT stand in for the student's consent", () => {
    expect(
      captionsConsentOk({ isMinor: false, captionsConsentAt: null, captionsGuardianConsentAt: T }),
    ).toBe(false);
  });
});
