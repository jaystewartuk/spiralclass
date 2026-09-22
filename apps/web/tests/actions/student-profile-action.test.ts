import { beforeEach, describe, expect, it, vi } from "vitest";

import { STUDENT_PROFILE_MAX_CHARS } from "@/lib/student-profile-fields";

// Teacher-private student profile (interests + goals on teacher_students, D-20).
// Pins: the per-field length cap, the teacher_id-scoped link lookup (a student
// not on this teacher's list → refusal, no write), empty-string → null
// transform, and the analytics + revalidate side-effects.

const state = { link: { studentId: "s1" } as { studentId: string } | null };

const findUnique = vi.fn(async (_a: { where: Record<string, unknown> }) => state.link);
const update = vi.fn(async (_a: Record<string, unknown>) => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacherStudent: { findUnique, update } },
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { setStudentProfile } = await import("@/app/actions/student-profile");

const SID = "11111111-1111-1111-1111-111111111111";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.link = { studentId: "s1" };
});

describe("setStudentProfile", () => {
  it("rejects an over-long field without writing", async () => {
    const res = await setStudentProfile(
      undefined,
      form({ studentId: SID, interests: "x".repeat(STUDENT_PROFILE_MAX_CHARS + 1), goals: "" }),
    );
    expect(res).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a student not on this teacher's list", async () => {
    state.link = null;
    const res = await setStudentProfile(
      undefined,
      form({ studentId: SID, interests: "música", goals: "" }),
    );
    expect(res).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
    // Lookup must be keyed on the composite (teacherId, studentId).
    expect(findUnique.mock.calls[0][0].where).toEqual({
      teacherId_studentId: { teacherId: "t1", studentId: SID },
    });
  });

  it("saves interests/goals scoped to the teacher and nulls empty fields", async () => {
    const res = await setStudentProfile(
      undefined,
      form({ studentId: SID, interests: "música", goals: "   " }),
    );
    expect(res).toMatchObject({ ok: expect.any(String) });
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { teacherId_studentId: { teacherId: "t1", studentId: SID } },
      data: { interests: "música", goals: null },
    });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "student_profile_set" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/students/${SID}`);
  });
});
