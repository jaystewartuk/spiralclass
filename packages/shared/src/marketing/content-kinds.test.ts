import { describe, expect, it } from "vitest";
import {
  CONTENT_KIND_SPECS,
  contentKindLabel,
  contentKindSummary,
  eligibleContentKinds,
  isMarketingContentKind,
  MARKETING_CONTENT_KINDS,
  meetsPrerequisites,
  type ContentCapabilities,
} from "./content-kinds";
import { MARKETING_PLATFORMS } from "./channels";

const EVERYTHING: ContentCapabilities = {
  hasTestimonial: true,
  hasPackage: true,
  hasStudents: true,
  hasAvailability: true,
  hasPhoto: true,
};

const NOTHING: ContentCapabilities = {
  hasTestimonial: false,
  hasPackage: false,
  hasStudents: false,
  hasAvailability: false,
  hasPhoto: false,
};

describe("prerequisites", () => {
  it("blocks a testimonial post when no testimonial is published", () => {
    // The alternative is a model inventing a student quote, which is the one
    // failure mode that would be genuinely damaging to a teacher.
    expect(meetsPrerequisites(CONTENT_KIND_SPECS.testimonial, NOTHING)).toBe(false);
    expect(meetsPrerequisites(CONTENT_KIND_SPECS.testimonial, EVERYTHING)).toBe(true);
  });

  it("blocks a package offer when there is no package to offer", () => {
    expect(meetsPrerequisites(CONTENT_KIND_SPECS.package_offer, NOTHING)).toBe(false);
  });

  it("blocks an availability post when no availability is configured", () => {
    expect(meetsPrerequisites(CONTENT_KIND_SPECS.availability, NOTHING)).toBe(false);
  });

  it("lets purely educational kinds through with nothing configured", () => {
    // A brand-new teacher must still have something honest to post on day one.
    for (const kind of ["tip", "common_mistake", "mini_lesson", "discussion_question"] as const) {
      expect(meetsPrerequisites(CONTENT_KIND_SPECS[kind], NOTHING)).toBe(true);
    }
  });
});

describe("eligibleContentKinds", () => {
  it("offers no promotional kind where promotion is prohibited", () => {
    const kinds = eligibleContentKinds({
      platform: "reddit",
      promoPolicy: "prohibited",
      capabilities: EVERYTHING,
    });
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(CONTENT_KIND_SPECS[k].promotional).toBe(false);
  });

  it("offers no promotional kind where the rules are merely unconfirmed", () => {
    const kinds = eligibleContentKinds({
      platform: "facebook_group",
      promoPolicy: "unknown",
      capabilities: EVERYTHING,
    });
    for (const k of kinds) expect(CONTENT_KIND_SPECS[k].promotional).toBe(false);
  });

  it("offers promotional kinds once the teacher confirms the community allows them", () => {
    const kinds = eligibleContentKinds({
      platform: "facebook_group",
      promoPolicy: "open",
      capabilities: EVERYTHING,
    });
    expect(kinds.some((k) => CONTENT_KIND_SPECS[k].promotional)).toBe(true);
  });

  it("never offers a kind the platform does not support", () => {
    for (const platform of MARKETING_PLATFORMS) {
      const kinds = eligibleContentKinds({
        platform,
        promoPolicy: "open",
        capabilities: EVERYTHING,
      });
      for (const k of kinds) expect(CONTENT_KIND_SPECS[k].platforms).toContain(platform);
    }
  });

  it("returns nothing promotional for a teacher with nothing to promote", () => {
    const kinds = eligibleContentKinds({
      platform: "facebook_group",
      promoPolicy: "open",
      capabilities: NOTHING,
    });
    expect(kinds).not.toContain("package_offer");
    expect(kinds).not.toContain("testimonial");
    expect(kinds).not.toContain("availability");
  });
});

describe("registry integrity", () => {
  it("gives every kind a brief, a family and copy in every locale", () => {
    for (const kind of MARKETING_CONTENT_KINDS) {
      const spec = CONTENT_KIND_SPECS[kind];
      expect(spec.brief.length).toBeGreaterThan(20);
      expect(spec.platforms.length).toBeGreaterThan(0);
      for (const locale of ["es-MX", "en", "fr"] as const) {
        expect(contentKindLabel(kind, locale).length).toBeGreaterThan(0);
        expect(contentKindSummary(kind, locale).length).toBeGreaterThan(0);
      }
    }
  });

  it("never marks a non-promotional kind as wanting a link", () => {
    // A link on an educational post in a no-promotion community is exactly the
    // thing that gets it removed.
    for (const kind of MARKETING_CONTENT_KINDS) {
      const spec = CONTENT_KIND_SPECS[kind];
      if (spec.wantsLink && kind !== "referral_ask") expect(spec.promotional).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    expect(isMarketingContentKind("tip")).toBe(true);
    expect(isMarketingContentKind("viral_growth_hack")).toBe(false);
  });
});
