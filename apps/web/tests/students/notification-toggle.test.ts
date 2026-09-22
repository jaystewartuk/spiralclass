import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher-authorized on/off switch for a student's notification categories
// (src/lib/students/notification-toggle.ts) — the mutation core behind the
// "launch this student" control on the teacher's student-profile page
// (web + mobile). Asserts:
// 1. Tenancy: a teacher can't touch a student off her roster.
//   2. "enabled" clears the column back to the product default (null).
//   3. "disabled" restores the exact CSV-import all-off shape.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";

type StudentRow = { id: string; notificationPrefs: unknown; teacherIds: string[] };

const state: { students: StudentRow[] } = { students: [] };

function freshState() {
  state.students.length = 0;
  state.students.push({
    id: STUDENT_ID,
    notificationPrefs: {
      booking_updates: false,
      class_materials: false,
      class_reminders: false,
      messages: false,
      expiry_reminders: false,
    },
    teacherIds: [TEACHER_ID],
  });
}

vi.mock("@/lib/prisma", () => {
  function studentUpdateMany({ where, data }: any) {
    const matches = state.students.filter((s) => {
      if (where.id !== s.id) return false;
      const teacherId = where.teacherStudents?.some?.teacherId;
      if (teacherId && !s.teacherIds.includes(teacherId)) return false;
      return true;
    });
    for (const s of matches) s.notificationPrefs = data.notificationPrefs;
    return { count: matches.length };
  }
  return { prisma: { student: { updateMany: studentUpdateMany } } };
});

const { setStudentNotificationsEnabledAsTeacher } =
  await import("@/lib/students/notification-toggle");
const { prisma } = await import("@/lib/prisma");
const { Prisma } = await import("@prisma/client");

beforeEach(() => freshState());

describe("setStudentNotificationsEnabledAsTeacher", () => {
  it("enabling clears the column to the product default (null)", async () => {
    const result = await setStudentNotificationsEnabledAsTeacher(
      prisma as any,
      TEACHER_ID,
      STUDENT_ID,
      true,
    );
    expect(result).toEqual({ ok: true });
    expect(state.students[0].notificationPrefs).toBe(Prisma.DbNull);
  });

  it("disabling restores the exact CSV-import all-off shape", async () => {
    state.students[0].notificationPrefs = null;
    const result = await setStudentNotificationsEnabledAsTeacher(
      prisma as any,
      TEACHER_ID,
      STUDENT_ID,
      false,
    );
    expect(result).toEqual({ ok: true });
    expect(state.students[0].notificationPrefs).toEqual({
      booking_updates: false,
      class_materials: false,
      class_reminders: false,
      messages: false,
      expiry_reminders: false,
    });
  });

  it("returns not-found for a student off the teacher's roster (tenant isolation)", async () => {
    const result = await setStudentNotificationsEnabledAsTeacher(
      prisma as any,
      OTHER_TEACHER_ID,
      STUDENT_ID,
      true,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
    // Unchanged — the write never happened.
    expect(state.students[0].notificationPrefs).not.toBeNull();
  });
});
