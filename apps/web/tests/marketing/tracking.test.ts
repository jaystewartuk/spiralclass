import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The tracked-link scheme is the load-bearing half of attribution: a code that
// parses loosely would let an anonymous caller point a visit at another
// teacher's activity, and a code that parses too strictly would silently drop
// the attribution on links already posted in real communities.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingActivity: { findFirst: vi.fn(), findUnique: vi.fn() },
    teacherShareGroup: { findMany: vi.fn() },
    acquisitionEvent: { create: vi.fn(), findFirst: vi.fn() },
    package: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import("@/lib/prisma");
const {
  trackingCampaign,
  trackingCodeFromAttribution,
  TRACKING_CAMPAIGN_PREFIX,
  activityFromAttribution,
  resolveCommunityFromAttribution,
} = await import("@/lib/marketing/events");
const { EMPTY_ATTRIBUTION } = await import("@/lib/analytics/attribution");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trackingCampaign / trackingCodeFromAttribution", () => {
  it("round-trips a minted code", () => {
    const campaign = trackingCampaign("abc234xyz9");
    expect(campaign).toBe(`${TRACKING_CAMPAIGN_PREFIX}abc234xyz9`);
    expect(trackingCodeFromAttribution({ ...EMPTY_ATTRIBUTION, campaign })).toBe("abc234xyz9");
  });

  it("ignores a campaign tag that isn't ours", () => {
    // `teacher_share` is the pre-D-125 campaign value on links already posted
    // in real Facebook groups. It must resolve to "no activity", not to a
    // garbled one.
    expect(
      trackingCodeFromAttribution({ ...EMPTY_ATTRIBUTION, campaign: "teacher_share" }),
    ).toBeNull();
    expect(trackingCodeFromAttribution(EMPTY_ATTRIBUTION)).toBeNull();
  });

  it("rejects a malformed or out-of-charset code rather than querying with it", () => {
    for (const bad of ["ap-", "ap-abc", "ap-ABCDEFGH", "ap-abc_def123", "ap-" + "a".repeat(40)]) {
      expect(trackingCodeFromAttribution({ ...EMPTY_ATTRIBUTION, campaign: bad })).toBeNull();
    }
  });
});

describe("activityFromAttribution", () => {
  it("scopes the lookup to the teacher, so one teacher's tag can't hit another's activity", async () => {
    vi.mocked(prisma.marketingActivity.findFirst).mockResolvedValue({ id: "act-1" } as never);
    const id = await activityFromAttribution("teacher-1", {
      ...EMPTY_ATTRIBUTION,
      campaign: "ap-abc234xyz9",
    });
    expect(id).toBe("act-1");
    expect(vi.mocked(prisma.marketingActivity.findFirst).mock.calls[0][0]).toMatchObject({
      where: { teacherId: "teacher-1", trackingCode: "abc234xyz9" },
    });
  });

  it("does not query at all when there is no code to resolve", async () => {
    const id = await activityFromAttribution("teacher-1", EMPTY_ATTRIBUTION);
    expect(id).toBeNull();
    expect(prisma.marketingActivity.findFirst).not.toHaveBeenCalled();
  });
});

describe("resolveCommunityFromAttribution", () => {
  it("still resolves the pre-D-125 share-group slug on links already posted", async () => {
    // The old share buttons tagged utm_content with `<name>-<4 hex of id>`.
    // Those links live in real community feeds indefinitely; if this stopped
    // resolving, every one of them would silently become "direct" traffic.
    vi.mocked(prisma.teacherShareGroup.findMany).mockResolvedValue([
      { id: "1a2b3c4d-0000-0000-0000-000000000000", name: "Oaxaca Expats" },
    ] as never);
    const id = await resolveCommunityFromAttribution("teacher-1", {
      ...EMPTY_ATTRIBUTION,
      content: "oaxaca-expats-1a2b",
    });
    expect(id).toBe("1a2b3c4d-0000-0000-0000-000000000000");
  });

  it("resolves a renamed group by its stable id suffix", async () => {
    vi.mocked(prisma.teacherShareGroup.findMany).mockResolvedValue([
      { id: "1a2b3c4d-0000-0000-0000-000000000000", name: "Something Else Now" },
    ] as never);
    const id = await resolveCommunityFromAttribution("teacher-1", {
      ...EMPTY_ATTRIBUTION,
      content: "oaxaca-expats-1a2b",
    });
    expect(id).toBe("1a2b3c4d-0000-0000-0000-000000000000");
  });

  it("returns null for a hand-typed tag rather than guessing a community", async () => {
    vi.mocked(prisma.teacherShareGroup.findMany).mockResolvedValue([
      { id: "1a2b3c4d-0000-0000-0000-000000000000", name: "Oaxaca Expats" },
    ] as never);
    expect(
      await resolveCommunityFromAttribution("teacher-1", {
        ...EMPTY_ATTRIBUTION,
        content: "some-newsletter",
      }),
    ).toBeNull();
  });
});
