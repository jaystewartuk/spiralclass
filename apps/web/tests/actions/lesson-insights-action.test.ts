import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase E validation actions: ownership/Pro guards + the profile recompute
// trigger. Prisma, auth, locale, the Pro gate, and the recompute are mocked so
// we exercise the action logic without a DB.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })) }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));

const gateProFeature = vi.fn(async () => ({ ok: true }) as { ok: boolean; limit?: unknown });
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => gateProFeature(...(a as [])),
  upgradeNudge: () => "Upgrade to Pro.",
}));

const recomputeStudentProfile = vi.fn(async () => {});
vi.mock("@/lib/lesson-notes/profile", () => ({ recomputeStudentProfile }));

const insightFindFirst = vi.fn();
const insightUpdate = vi.fn(async (_args: any) => ({}));
const insightCreate = vi.fn(async (_args: any) => ({}));
const bookingFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lessonInsight: {
      findFirst: (...a: unknown[]) => insightFindFirst(...(a as [])),
      update: (...a: unknown[]) => insightUpdate(...(a as [any])),
      create: (...a: unknown[]) => insightCreate(...(a as [any])),
    },
    booking: { findFirst: (...a: unknown[]) => bookingFindFirst(...(a as [])) },
  },
}));

const { confirmInsight, dismissInsight, addInsight } =
  await import("@/app/actions/lesson-insights");

const OWNED = {
  id: "i1",
  bookingId: "b1",
  category: "grammar",
  summary: "ser/estar",
  booking: { studentId: "s1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  gateProFeature.mockResolvedValue({ ok: true });
  insightFindFirst.mockResolvedValue(OWNED);
  bookingFindFirst.mockResolvedValue({ id: "b1", studentId: "s1" });
});

describe("confirmInsight", () => {
  it("confirms with a skill and recomputes the profile", async () => {
    const res = await confirmInsight("i1", "ser_vs_estar");
    expect(res).toEqual({ ok: true });
    expect(insightUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "i1" },
        data: expect.objectContaining({ skill: "ser_vs_estar", dismissedAt: null }),
      }),
    );
    expect(insightUpdate.mock.calls[0][0].data.confirmedAt).toBeInstanceOf(Date);
    expect(recomputeStudentProfile).toHaveBeenCalledWith(expect.anything(), {
      teacherId: "t1",
      studentId: "s1",
    });
  });

  it("derives a skill from the summary when none is given", async () => {
    await confirmInsight("i1");
    expect(insightUpdate.mock.calls[0][0].data.skill).toBe("ser_vs_estar");
  });

  it("returns not-found for an insight the teacher doesn't own", async () => {
    insightFindFirst.mockResolvedValueOnce(null);
    const res = await confirmInsight("i1", "x");
    expect(res.error).toMatch(/not found/i);
    expect(insightUpdate).not.toHaveBeenCalled();
    expect(recomputeStudentProfile).not.toHaveBeenCalled();
  });

  it("blocks a non-Pro teacher with the upgrade nudge", async () => {
    gateProFeature.mockResolvedValueOnce({ ok: false, limit: {} });
    const res = await confirmInsight("i1", "x");
    expect(res.error).toBe("Upgrade to Pro.");
    expect(insightUpdate).not.toHaveBeenCalled();
  });
});

describe("dismissInsight", () => {
  it("sets dismissedAt, clears confirmedAt, and recomputes", async () => {
    const res = await dismissInsight("i1");
    expect(res).toEqual({ ok: true });
    expect(insightUpdate.mock.calls[0][0].data).toMatchObject({ confirmedAt: null });
    expect(insightUpdate.mock.calls[0][0].data.dismissedAt).toBeInstanceOf(Date);
    expect(recomputeStudentProfile).toHaveBeenCalled();
  });
});

describe("addInsight", () => {
  it("creates a teacher-authored, confirmed row and recomputes", async () => {
    const res = await addInsight("b1", { category: "vocabulary", summary: "la sobremesa" });
    expect(res).toEqual({ ok: true });
    const data = insightCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      bookingId: "b1",
      teacherId: "t1",
      source: "teacher",
      category: "vocabulary",
    });
    expect(data.confirmedAt).toBeInstanceOf(Date);
    expect(recomputeStudentProfile).toHaveBeenCalledWith(expect.anything(), {
      teacherId: "t1",
      studentId: "s1",
    });
  });

  it("rejects an empty summary", async () => {
    const res = await addInsight("b1", { category: "grammar", summary: "  " });
    expect(res.error).toBeTruthy();
    expect(insightCreate).not.toHaveBeenCalled();
  });
});
