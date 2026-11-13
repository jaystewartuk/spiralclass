import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, roster, audit } = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "package-1" })),
  roster: vi.fn(async () => ({ studentId: "student-1" })),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: async () => ({
    id: "teacher-1",
    timezone: "UTC",
    pricingCurrency: "GBP",
  }),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "en" }));
vi.mock("@/lib/audit", () => ({ writeOverride: audit }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(),
}));
vi.mock("@/lib/revalidate", () => ({ revalidateAfterAction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: { findUnique: roster },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ package: { create } }),
  },
}));

const { createManualPackageAction } = await import("@/app/actions/teacher-packages");
const STUDENT_ID = "11111111-1111-4111-8111-111111111111";

function form(remaining: string | null) {
  const data = new FormData();
  data.set("studentId", STUDENT_ID);
  data.set("classesTotal", "10");
  if (remaining !== null) data.set("classesRemaining", remaining);
  return data;
}

beforeEach(() => vi.clearAllMocks());

describe("recording a package balance", () => {
  it.each([null, "", "   "])("rejects an omitted or blank balance (%j)", async (remaining) => {
    expect(await createManualPackageAction(undefined, form(remaining))).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["10", 0],
    ["4", 6],
    ["0", 10],
  ])("records %s remaining without confusing it with classes used", async (remaining, used) => {
    expect(await createManualPackageAction(undefined, form(remaining))).toHaveProperty("ok");
    expect(roster).toHaveBeenCalledWith({
      where: { teacherId_studentId: { teacherId: "teacher-1", studentId: STUDENT_ID } },
      select: { studentId: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teacherId: "teacher-1",
        studentId: STUDENT_ID,
        classesTotal: 10,
        classesUsed: used,
        status: "active",
      }),
      select: { id: true },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_manual_package" }),
    );
  });
});
