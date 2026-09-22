import { beforeEach, describe, expect, it, vi } from "vitest";

// Lesson-insights consent gate (D-22): the teacher records/revokes the
// per-student consent capture is gated on, and flags minors. Prisma, auth,
// locale, and the Pro gate are mocked so we exercise the action logic without a DB.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })) }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));

const gateProFeature = vi.fn(async () => ({ ok: true }) as { ok: boolean; limit?: unknown });
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => gateProFeature(...(a as [])),
  upgradeNudge: () => "Upgrade to Pro.",
}));

const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: { updateMany: (...a: unknown[]) => updateMany(...(a as [any])) },
  },
}));

const { setInsightsConsent } = await import("@/app/actions/insights-consent");

beforeEach(() => {
  vi.clearAllMocks();
  gateProFeature.mockResolvedValue({ ok: true });
  updateMany.mockResolvedValue({ count: 1 });
});

describe("setInsightsConsent", () => {
  it("adult consent: stamps insightsConsentAt and clears the guardian field", async () => {
    const res = await setInsightsConsent("s1", { isMinor: false, consented: true });
    expect(res).toEqual({ ok: true });
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where).toEqual({ teacherId: "t1", studentId: "s1" });
    expect(data.isMinor).toBe(false);
    expect(data.insightsConsentAt).toBeInstanceOf(Date);
    expect(data.guardianConsentAt).toBeNull();
  });

  it("minor consent: stamps guardianConsentAt and clears the student field", async () => {
    await setInsightsConsent("s1", { isMinor: true, consented: true });
    const { data } = updateMany.mock.calls[0][0];
    expect(data.isMinor).toBe(true);
    expect(data.guardianConsentAt).toBeInstanceOf(Date);
    expect(data.insightsConsentAt).toBeNull();
  });

  it("revoke: clears both timestamps", async () => {
    await setInsightsConsent("s1", { isMinor: false, consented: false });
    const { data } = updateMany.mock.calls[0][0];
    expect(data.insightsConsentAt).toBeNull();
    expect(data.guardianConsentAt).toBeNull();
  });

  it("returns not-found when the pair doesn't exist", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await setInsightsConsent("s1", { isMinor: false, consented: true });
    expect(res.error).toMatch(/not found/i);
  });

  it("blocks a non-Pro teacher with the upgrade nudge", async () => {
    gateProFeature.mockResolvedValueOnce({ ok: false, limit: {} });
    const res = await setInsightsConsent("s1", { isMinor: false, consented: true });
    expect(res.error).toBe("Upgrade to Pro.");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
