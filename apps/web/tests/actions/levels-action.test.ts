import { beforeEach, describe, expect, it, vi } from "vitest";

// setStudentLevel sets a student's per-teacher level (it lives on
// teacher_students). Security-relevant guards: the student must be on the
// caller's roster, and a non-empty level id must belong to THIS teacher
// (never trust the posted id). Empty string clears the level.

const state = {
  link: null as { studentId: string } | null,
  ownedLevel: null as { id: string } | null,
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const tsUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findUnique: vi.fn(async () => state.link),
      update: tsUpdate,
    },
    level: { findFirst: vi.fn(async () => state.ownedLevel) },
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));

const { setStudentLevel } = await import("@/app/actions/levels");

const STUDENT = "22222222-2222-4222-8222-222222222222";
const LEVEL = "33333333-3333-4333-8333-333333333333";

function fd(studentId: string, levelId: string): FormData {
  const f = new FormData();
  f.set("studentId", studentId);
  f.set("levelId", levelId);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.link = { studentId: STUDENT };
  state.ownedLevel = { id: LEVEL };
});

describe("setStudentLevel", () => {
  it("rejects a non-uuid student id", async () => {
    const res = await setStudentLevel(undefined, fd("nope", ""));
    expect(res).toHaveProperty("error");
    expect(tsUpdate).not.toHaveBeenCalled();
  });

  it("refuses a student not on the teacher's roster", async () => {
    state.link = null;
    const res = await setStudentLevel(undefined, fd(STUDENT, ""));
    expect(res).toHaveProperty("error");
    expect(tsUpdate).not.toHaveBeenCalled();
  });

  it("rejects a level id the teacher doesn't own", async () => {
    state.ownedLevel = null;
    const res = await setStudentLevel(undefined, fd(STUDENT, LEVEL));
    expect(res).toHaveProperty("error");
    expect(tsUpdate).not.toHaveBeenCalled();
  });

  it("sets an owned level on the roster link", async () => {
    const res = await setStudentLevel(undefined, fd(STUDENT, LEVEL));
    expect(res).toHaveProperty("ok");
    expect(tsUpdate).toHaveBeenCalledWith({
      where: { teacherId_studentId: { teacherId: "t1", studentId: STUDENT } },
      data: { levelId: LEVEL },
    });
  });

  it("clears the level when given an empty string (no ownership check needed)", async () => {
    const res = await setStudentLevel(undefined, fd(STUDENT, ""));
    expect(res).toHaveProperty("ok");
    expect(tsUpdate).toHaveBeenCalledWith({
      where: { teacherId_studentId: { teacherId: "t1", studentId: STUDENT } },
      data: { levelId: null },
    });
  });
});
