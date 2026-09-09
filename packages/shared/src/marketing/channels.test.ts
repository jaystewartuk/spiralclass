import { describe, expect, it } from "vitest";
import {
  allowsDirectPromotion,
  allowsInlineLink,
  isMarketingPlatform,
  isPromoPolicy,
  MARKETING_PLATFORMS,
  PLATFORM_SPECS,
  platformLabel,
  promoPolicyLabel,
  PROMO_POLICIES,
} from "./channels";

// The promotion gate is the single most consequential rule in the acquisition
// system: it is what stands between "software that helps a teacher market" and
// "software that gets her removed from the communities she depends on". These
// tests pin its conservative direction, which is easy to loosen by accident.

describe("allowsDirectPromotion", () => {
  it("permits promotion only where the teacher confirmed the community allows it", () => {
    expect(allowsDirectPromotion("open")).toBe(true);
    expect(allowsDirectPromotion("limited")).toBe(true);
  });

  it("refuses when promotion is prohibited", () => {
    expect(allowsDirectPromotion("prohibited")).toBe(false);
  });

  it("treats UNKNOWN as not allowed — silence is never consent", () => {
    // The default for every legacy row and every community a teacher adds
    // without answering. Flipping this to `true` would start posting offers
    // into communities whose rules nobody has read.
    expect(allowsDirectPromotion("unknown")).toBe(false);
  });
});

describe("platform defaults", () => {
  it("defaults Reddit to prohibited", () => {
    // Reddit's site-wide culture treats unsolicited self-promotion as spam;
    // starting anywhere else would ship the ban as the default experience.
    expect(PLATFORM_SPECS.reddit.defaultPromoPolicy).toBe("prohibited");
  });

  it("never defaults any platform to `open` unless a link is safe there", () => {
    for (const p of MARKETING_PLATFORMS) {
      const spec = PLATFORM_SPECS[p];
      if (spec.defaultPromoPolicy === "open") {
        expect(["inline", "profile_only"]).toContain(spec.linkPlacement);
      }
    }
  });

  it("keeps Reddit's rules explicit about no link and no advertisement", () => {
    const joined = PLATFORM_SPECS.reddit.rules.join(" ").toLowerCase();
    expect(joined).toContain("booking link");
    expect(joined).toContain("advertisement");
  });
});

describe("allowsInlineLink", () => {
  it("allows an inline link only when the platform AND the policy both permit it", () => {
    expect(allowsInlineLink("facebook_group", "open")).toBe(true);
    expect(allowsInlineLink("facebook_group", "unknown")).toBe(false);
    expect(allowsInlineLink("facebook_group", "prohibited")).toBe(false);
  });

  it("never allows an inline link on Reddit, whatever the policy says", () => {
    for (const policy of PROMO_POLICIES) {
      expect(allowsInlineLink("reddit", policy)).toBe(false);
    }
  });

  it("never allows an inline link on Instagram — captions do not link", () => {
    for (const policy of PROMO_POLICIES) {
      expect(allowsInlineLink("instagram", policy)).toBe(false);
    }
  });
});

describe("guards", () => {
  it("rejects values that are not registry members", () => {
    expect(isMarketingPlatform("facebook_group")).toBe(true);
    expect(isMarketingPlatform("myspace")).toBe(false);
    expect(isMarketingPlatform(null)).toBe(false);
    expect(isPromoPolicy("open")).toBe(true);
    expect(isPromoPolicy("sure_why_not")).toBe(false);
  });
});

describe("labels", () => {
  it("has copy for every platform and policy in every locale", () => {
    for (const locale of ["es-MX", "en", "fr"] as const) {
      for (const p of MARKETING_PLATFORMS) {
        expect(platformLabel(p, locale).length).toBeGreaterThan(0);
      }
      for (const policy of PROMO_POLICIES) {
        expect(promoPolicyLabel(policy, locale).length).toBeGreaterThan(0);
      }
    }
  });
});
