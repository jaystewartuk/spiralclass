import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Channel bucketing decides what every row of the results screen says. Getting
// it wrong doesn't error — it silently credits the wrong channel, which is the
// one failure mode a teacher would act on without ever noticing.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    acquisitionEvent: { findMany: vi.fn(), groupBy: vi.fn() },
    teacherShareGroup: { findMany: vi.fn() },
    marketingActivity: { findMany: vi.fn() },
  },
}));

const { channelKeyFor, channelLabel } = await import("@/lib/marketing/analytics");

describe("channelKeyFor", () => {
  it("treats a referral as its own channel, whatever the source says", () => {
    // A friend who arrived because an existing student vouched for the teacher
    // did not come "from Facebook" in any sense she can act on.
    expect(channelKeyFor({ source: "facebook", viaReferral: true })).toBe("referral");
    expect(channelKeyFor({ source: null, viaReferral: true })).toBe("referral");
  });

  it("folds the platform's own source spellings into one bucket", () => {
    for (const s of ["facebook", "fb", "facebook.com", "m.facebook"]) {
      expect(channelKeyFor({ source: s, viaReferral: false })).toBe("facebook");
    }
    expect(channelKeyFor({ source: "reddit", viaReferral: false })).toBe("reddit");
    expect(channelKeyFor({ source: "wa", viaReferral: false })).toBe("whatsapp");
    expect(channelKeyFor({ source: "ig", viaReferral: false })).toBe("instagram");
  });

  it("calls an untagged visit `direct` rather than dropping it", () => {
    // Dropping it would inflate every conversion rate measured against visits.
    expect(channelKeyFor({ source: null, viaReferral: false })).toBe("direct");
    expect(channelKeyFor({ source: "", viaReferral: false })).toBe("direct");
  });

  it("passes an unrecognised source through instead of guessing", () => {
    expect(channelKeyFor({ source: "newsletter", viaReferral: false })).toBe("newsletter");
  });
});

describe("channelLabel", () => {
  it("localises known channels and falls back to the raw key", () => {
    expect(channelLabel("referral", "es-MX")).toBe("Recomendaciones");
    expect(channelLabel("referral", "en")).toBe("Referrals");
    expect(channelLabel("direct", "es-MX")).toBe("Directo");
    expect(channelLabel("newsletter", "en")).toBe("newsletter");
  });
});
