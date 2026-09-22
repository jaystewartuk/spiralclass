import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The funnel's terminal step. A settled payment arrives on a webhook with no
// browser and no cookie, so the ONLY copy of "which community won this student"
// is the `booking` row written at checkout. If that inheritance breaks, every
// purchase silently becomes untracked and the results screen quietly
// under-reports every channel.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com", SESSION_SECRET: "x".repeat(32) }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    acquisitionEvent: { create: vi.fn(), findFirst: vi.fn() },
    package: { findUnique: vi.fn() },
    marketingActivity: { findFirst: vi.fn(), findUnique: vi.fn() },
    teacherShareGroup: { findMany: vi.fn() },
  },
}));

const { prisma } = await import("@/lib/prisma");
const { recordPurchase, recordPurchaseForActivation } = await import("@/lib/marketing/events");

beforeEach(() => {
  vi.clearAllMocks();
});

const BOOKING_ROW = {
  visitorHash: "vh",
  source: "facebook",
  medium: "community",
  campaign: "ap-abc234xyz9",
  content: null,
  referrer: null,
  activityId: "act-1",
  communityId: "c1",
  viaReferral: false,
};

describe("recordPurchase", () => {
  it("inherits the attribution captured at checkout", async () => {
    vi.mocked(prisma.acquisitionEvent.findFirst)
      .mockResolvedValueOnce(null as never) // no existing purchase
      .mockResolvedValueOnce(BOOKING_ROW as never); // the booking row
    await recordPurchase(prisma, {
      teacherId: "teacher-1",
      packageId: "pkg-1",
      studentId: "stu-1",
      amountMinorUnits: 250000,
      currency: "MXN",
    });
    expect(vi.mocked(prisma.acquisitionEvent.create).mock.calls[0][0].data).toMatchObject({
      kind: "purchase",
      source: "facebook",
      activityId: "act-1",
      communityId: "c1",
      amountMinorUnits: 250000,
      currency: "MXN",
    });
  });

  it("is idempotent — both payment rails can land without double-counting", async () => {
    vi.mocked(prisma.acquisitionEvent.findFirst).mockResolvedValueOnce({ id: "e1" } as never);
    await recordPurchase(prisma, {
      teacherId: "teacher-1",
      packageId: "pkg-1",
      studentId: "stu-1",
      amountMinorUnits: 1,
      currency: "MXN",
    });
    expect(prisma.acquisitionEvent.create).not.toHaveBeenCalled();
  });

  it("still records an untracked purchase when there is no booking row", async () => {
    // A repurchase from the portal has no acquisition channel. It must still
    // appear in revenue, bucketed as `direct`, not vanish.
    vi.mocked(prisma.acquisitionEvent.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);
    await recordPurchase(prisma, {
      teacherId: "teacher-1",
      packageId: "pkg-2",
      studentId: "stu-1",
      amountMinorUnits: 100,
      currency: "MXN",
    });
    expect(vi.mocked(prisma.acquisitionEvent.create).mock.calls[0][0].data).toMatchObject({
      kind: "purchase",
      source: null,
      activityId: null,
    });
  });

  it("never throws into its caller — measurement must not roll back a payment", async () => {
    vi.mocked(prisma.acquisitionEvent.findFirst).mockRejectedValue(new Error("db down"));
    await expect(
      recordPurchase(prisma, {
        teacherId: "teacher-1",
        packageId: "pkg-1",
        studentId: "stu-1",
        amountMinorUnits: 1,
        currency: "MXN",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("recordPurchaseForActivation", () => {
  it("records only for a package that actually activated", async () => {
    vi.mocked(prisma.package.findUnique).mockResolvedValue({
      teacherId: "teacher-1",
      studentId: "stu-1",
      pricePaidMinorUnits: 250000,
      currency: "MXN",
      status: "refunded",
    } as never);
    await recordPurchaseForActivation("pkg-1");
    expect(prisma.acquisitionEvent.create).not.toHaveBeenCalled();
  });

  it("reads the amount off the package rather than trusting a caller", async () => {
    vi.mocked(prisma.package.findUnique).mockResolvedValue({
      teacherId: "teacher-1",
      studentId: "stu-1",
      pricePaidMinorUnits: 250000,
      currency: "MXN",
      status: "active",
    } as never);
    vi.mocked(prisma.acquisitionEvent.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);
    await recordPurchaseForActivation("pkg-1");
    expect(vi.mocked(prisma.acquisitionEvent.create).mock.calls[0][0].data).toMatchObject({
      amountMinorUnits: 250000,
      currency: "MXN",
      studentId: "stu-1",
    });
  });
});
