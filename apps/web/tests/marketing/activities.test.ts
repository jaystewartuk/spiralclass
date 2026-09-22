import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Two things are checked here, and both are safety rather than behaviour:
// a community id from a form is never trusted as proof of ownership, and a
// tracking link is never minted for a post whose platform forbids one.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com", SESSION_SECRET: "x".repeat(32) }),
  socialPreviewAiEnabled: () => false,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingActivity: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    teacherShareGroup: { findFirst: vi.fn() },
    teacherStudent: { findFirst: vi.fn() },
    acquisitionEvent: { groupBy: vi.fn() },
  },
}));

const { prisma } = await import("@/lib/prisma");
const { createActivity, trackedLinkFor } = await import("@/lib/marketing/activities");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.marketingActivity.create).mockResolvedValue({ id: "act-1" } as never);
});

function createdData() {
  return vi.mocked(prisma.marketingActivity.create).mock.calls[0][0].data as Record<
    string,
    unknown
  >;
}

describe("createActivity — ownership", () => {
  it("drops a community id that does not belong to the teacher", async () => {
    vi.mocked(prisma.teacherShareGroup.findFirst).mockResolvedValue(null as never);
    await createActivity({
      teacherId: "teacher-1",
      communityId: "someone-elses-community",
      kind: "tip",
      platform: "facebook_group",
    });
    expect(createdData().communityId).toBeNull();
  });

  it("drops a student id that is not on the teacher's roster", async () => {
    vi.mocked(prisma.teacherStudent.findFirst).mockResolvedValue(null as never);
    await createActivity({
      teacherId: "teacher-1",
      studentId: "someone-elses-student",
      kind: "referral_ask",
      platform: "whatsapp",
    });
    expect(createdData().studentId).toBeNull();
  });

  it("keeps ids the teacher genuinely owns", async () => {
    vi.mocked(prisma.teacherShareGroup.findFirst).mockResolvedValue({ id: "c1" } as never);
    await createActivity({
      teacherId: "teacher-1",
      communityId: "c1",
      kind: "tip",
      platform: "facebook_group",
    });
    expect(createdData().communityId).toBe("c1");
  });
});

describe("createActivity — tracking codes", () => {
  it("mints no code for a Reddit comment, whose rules forbid a link", async () => {
    vi.mocked(prisma.teacherShareGroup.findFirst).mockResolvedValue({
      id: "c1",
      promoPolicy: "open",
    } as never);
    await createActivity({
      teacherId: "teacher-1",
      communityId: "c1",
      kind: "community_reply",
      platform: "reddit",
    });
    expect(createdData().trackingCode).toBeNull();
  });

  it("mints no code where the community's rules are unconfirmed", async () => {
    vi.mocked(prisma.teacherShareGroup.findFirst).mockResolvedValue({
      id: "c1",
      promoPolicy: "unknown",
    } as never);
    await createActivity({
      teacherId: "teacher-1",
      communityId: "c1",
      kind: "package_offer",
      platform: "facebook_group",
    });
    expect(createdData().trackingCode).toBeNull();
  });

  it("mints a code for a promotional post in a community that allows one", async () => {
    vi.mocked(prisma.teacherShareGroup.findFirst).mockResolvedValue({
      id: "c1",
      promoPolicy: "open",
    } as never);
    await createActivity({
      teacherId: "teacher-1",
      communityId: "c1",
      kind: "package_offer",
      platform: "facebook_group",
    });
    const code = createdData().trackingCode;
    expect(typeof code).toBe("string");
    // Charset must match what /g/<code> and the campaign parser both accept.
    expect(code).toMatch(/^[a-z0-9]{10}$/);
  });
});

describe("trackedLinkFor", () => {
  it("produces a short, paste-safe link with no tracking parameters on show", () => {
    // A booking URL with four utm parameters reads as an ad in a community
    // feed — which is what got posts removed and teachers editing the tags off.
    expect(trackedLinkFor("abc234xyz9")).toBe("https://spiralclass.com/g/abc234xyz9");
    expect(trackedLinkFor("abc234xyz9")).not.toContain("utm_");
  });
});
