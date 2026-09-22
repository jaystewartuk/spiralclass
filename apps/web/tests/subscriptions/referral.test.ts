import { describe, expect, it } from "vitest";
import {
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_QUERY_PARAM,
  normalizeReferralCode,
} from "@/lib/subscriptions/referral";

// Ambassador attribution capture — normalizeReferralCode sanitises an
// incoming ?ref= value before it is stamped into a first-party cookie and
// later persisted to teachers.referral_source.

describe("normalizeReferralCode", () => {
  it("trims and lowercases", () => {
    expect(normalizeReferralCode("  Alicia-Moreno  ")).toBe("alicia-moreno");
  });

  it("strips characters outside the safe slug set", () => {
    expect(normalizeReferralCode("alicia moreno!@#$%")).toBe("aliciamoreno");
  });

  it("keeps dots, underscores, and hyphens", () => {
    expect(normalizeReferralCode("a.b_c-d")).toBe("a.b_c-d");
  });

  it("caps the code at 64 characters", () => {
    expect(normalizeReferralCode("x".repeat(100))).toHaveLength(64);
  });

  it("returns null for nullish or empty-after-cleaning input", () => {
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode("   ")).toBeNull();
    expect(normalizeReferralCode("!!!")).toBeNull();
  });
});

describe("referral constants", () => {
  it("pins the cookie name, query param, and 30-day max-age", () => {
    expect(REFERRAL_COOKIE).toBe("ap_ref");
    expect(REFERRAL_QUERY_PARAM).toBe("ref");
    expect(REFERRAL_COOKIE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
