import { beforeEach, describe, expect, it, vi } from "vitest";

// Direct unit coverage for the two "first transition" analytics-fire helpers
// in lib/marketplace-ready.ts.
// Previously only exercised indirectly (via onboarding/profile actions with a
// null-returning findUnique short-circuit) — this file is the actual proof
// the transition/idempotency logic works, and that both functions take their
// Prisma client as an explicit parameter (never the `@/lib/prisma` singleton
// — see the module-level comment on why: a real bug, once, in
// maybeEmitFirstPayment, from doing exactly that inside a DI'd caller).

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent,
  flushAnalytics: vi.fn(async () => {}),
}));

const { maybeEmitMarketplaceReady, maybeEmitProfileCompleted } =
  await import("@/lib/marketplace-ready");

const READY_TEACHER = {
  onboardingCompleteAt: new Date("2026-01-01"),
  photoPath: "t1",
  bio: "Profesora de inglés.",
  templatesTouchedAt: new Date("2026-01-01"),
  availabilityTouchedAt: new Date("2026-01-01"),
  stripeChargesEnabled: true,
  pricingCurrency: "MXN",
  payoutInstruments: [],
  marketplaceReadyAt: null as Date | null,
};

function fakePrisma(teacher: Record<string, unknown> | null) {
  const updateMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if (!teacher) return { count: 0 };
    // Mirror the real conditional-update guard: only "wins" when the row
    // still matches the where clause's null-check.
    for (const [key, value] of Object.entries(args.where)) {
      if (key === "id") continue;
      if (teacher[key] !== value) return { count: 0 };
    }
    return { count: 1 };
  });
  const findUnique = vi.fn(async () => teacher);
  return { teacher: { findUnique, update: vi.fn(), updateMany } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("maybeEmitMarketplaceReady", () => {
  it("no-ops when the teacher doesn't exist", async () => {
    const prisma = fakePrisma(null);
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("no-ops when already marked ready (skips re-evaluating signals)", async () => {
    const prisma = fakePrisma({ ...READY_TEACHER, marketplaceReadyAt: new Date("2026-01-02") });
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("no-ops when a sub-signal is still missing (e.g. no payout rail)", async () => {
    const prisma = fakePrisma({
      ...READY_TEACHER,
      stripeChargesEnabled: false,
      wisePaymentsEnabled: false,
    });
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("stamps marketplaceReadyAt and fires marketplace_ready on the first true transition", async () => {
    const prisma = fakePrisma({ ...READY_TEACHER });
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(prisma.teacher.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", marketplaceReadyAt: null },
      data: { marketplaceReadyAt: expect.any(Date) },
    });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "marketplace_ready",
      distinctId: "t1",
      properties: { teacherId: "t1" },
    });
  });

  it("accepts Wise as an alternative payout rail to Stripe", async () => {
    const prisma = fakePrisma({
      ...READY_TEACHER,
      stripeChargesEnabled: false,
      pricingCurrency: "MXN",
      payoutInstruments: [
        { kind: "wise", enabled: true, wiseHandle: "mira.wise", schemeId: null, details: null },
      ],
    });
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "marketplace_ready" }),
    );
  });

  it("does not fire when it loses the conditional-update race (another caller already flipped it)", async () => {
    const prisma = fakePrisma({ ...READY_TEACHER });
    // Simulate a concurrent winner: updateMany matches 0 rows despite ready=true.
    (prisma.teacher.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    await maybeEmitMarketplaceReady(prisma as never, "t1");
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});

describe("maybeEmitProfileCompleted", () => {
  const PROFILE_TEACHER = { photoPath: "t1", bio: "Bio", profileCompletedAt: null as Date | null };

  it("no-ops when the teacher doesn't exist", async () => {
    const prisma = fakePrisma(null);
    await maybeEmitProfileCompleted(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("no-ops when already marked complete", async () => {
    const prisma = fakePrisma({ ...PROFILE_TEACHER, profileCompletedAt: new Date("2026-01-02") });
    await maybeEmitProfileCompleted(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("no-ops when only one of photo/bio is set", async () => {
    const prisma = fakePrisma({ ...PROFILE_TEACHER, bio: null });
    await maybeEmitProfileCompleted(prisma as never, "t1");
    expect(prisma.teacher.updateMany).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("stamps profileCompletedAt and fires profile_completed on the first true transition", async () => {
    const prisma = fakePrisma({ ...PROFILE_TEACHER });
    await maybeEmitProfileCompleted(prisma as never, "t1");
    expect(prisma.teacher.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", profileCompletedAt: null },
      data: { profileCompletedAt: expect.any(Date) },
    });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "profile_completed",
      distinctId: "t1",
      properties: { teacherId: "t1" },
    });
  });

  it("does not fire when it loses the conditional-update race", async () => {
    const prisma = fakePrisma({ ...PROFILE_TEACHER });
    (prisma.teacher.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    await maybeEmitProfileCompleted(prisma as never, "t1");
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});
