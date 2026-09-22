import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// trackTeacherSignIn is the body of the better-auth session.create.after hook.
// It must: emit teacher_signed_in keyed on teacher.id for a teacher session,
// stay silent for non-teachers, and never throw (analytics can't break auth).

const teacherFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { teacher: { findUnique: teacherFindUnique } } }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn() }));

const { trackTeacherSignIn } = await import("@/lib/auth/sign-in-analytics");
const { trackServerEvent } = await import("@/lib/analytics/posthog");
const trackServerEventMock = trackServerEvent as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trackTeacherSignIn", () => {
  it("emits teacher_signed_in keyed on teacher.id for a teacher session", async () => {
    teacherFindUnique.mockResolvedValueOnce({ id: "user-teacher-1" });
    await trackTeacherSignIn("user-teacher-1");
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "teacher_signed_in",
      distinctId: "user-teacher-1",
      properties: { teacherId: "user-teacher-1" },
    });
  });

  it("stays silent for a non-teacher session (student / admin — no teacher row)", async () => {
    teacherFindUnique.mockResolvedValueOnce(null);
    await trackTeacherSignIn("user-student-1");
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it("swallows lookup errors so a DB blip can never break sign-in", async () => {
    teacherFindUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(trackTeacherSignIn("user-x")).resolves.toBeUndefined();
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });
});
