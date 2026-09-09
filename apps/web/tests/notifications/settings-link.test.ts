import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNotificationSettingsLink } from "@/lib/notifications/settings-link";
import { signNotificationSettingsToken } from "@/lib/notifications/settings-link-token";

// Fake-prisma pattern mirrors tests/redirects/email-opt-out-handler.test.ts.

const SECRET = "test-secret-of-sufficient-length-for-hmac";
const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "99999999-9999-4999-8999-999999999999";
const STUDENT_ROSTER_ID = "22222222-2222-4222-8222-222222222222";
const STUDENT_AUTH_USER_ID = "33333333-3333-4333-8333-333333333333";

type TeacherRow = { id: string; email: string; name: string };
type StudentRow = {
  id: string;
  authUserId: string | null;
  email: string | null;
  name: string;
  teacherIds: Set<string>;
};

function buildPrisma(opts: { teacher?: TeacherRow | null; student?: StudentRow | null }) {
  return {
    teacher: {
      findUnique: vi.fn(async ({ where }: any) =>
        opts.teacher && opts.teacher.id === where.id ? opts.teacher : null,
      ),
    },
    student: {
      findFirst: vi.fn(async ({ where }: any) => {
        const s = opts.student;
        if (!s || s.id !== where.id) return null;
        const teacherId = where.teacherStudents?.some?.teacherId;
        if (teacherId && !s.teacherIds.has(teacherId)) return null;
        return s;
      }),
    },
  } as any;
}

describe("resolveNotificationSettingsLink", () => {
  let teacher: TeacherRow;
  let student: StudentRow;

  beforeEach(() => {
    teacher = { id: TEACHER_ID, email: "mira@example.com", name: "Alicia Moreno" };
    student = {
      id: STUDENT_ROSTER_ID,
      authUserId: STUDENT_AUTH_USER_ID,
      email: "bob@example.com",
      name: "Bob",
      teacherIds: new Set([TEACHER_ID]),
    };
  });

  it("resolves a teacher recipient to their own account id", async () => {
    const token = signNotificationSettingsToken(
      { recipientId: TEACHER_ID, recipientType: "teacher", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ teacher }), secret: SECRET },
      token,
    );
    expect(result).toEqual({
      ok: true,
      target: {
        accountId: TEACHER_ID,
        role: "teacher",
        email: "mira@example.com",
        name: "Alicia Moreno",
      },
    });
  });

  it("resolves a linked student recipient to their auth user id (distinct from the roster row id)", async () => {
    const token = signNotificationSettingsToken(
      { recipientId: STUDENT_ROSTER_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ student }), secret: SECRET },
      token,
    );
    expect(result).toEqual({
      ok: true,
      target: {
        accountId: STUDENT_AUTH_USER_ID,
        role: "student",
        email: "bob@example.com",
        name: "Bob",
      },
    });
  });

  it("resolves a never-signed-in student with a null accountId (nothing to match locally)", async () => {
    student.authUserId = null;
    const token = signNotificationSettingsToken(
      { recipientId: STUDENT_ROSTER_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ student }), secret: SECRET },
      token,
    );
    expect(result).toEqual({
      ok: true,
      target: { accountId: null, role: "student", email: "bob@example.com", name: "Bob" },
    });
  });

  it("rejects a tampered token", async () => {
    const token = signNotificationSettingsToken(
      { recipientId: TEACHER_ID, recipientType: "teacher", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ teacher }), secret: SECRET },
      token + "x",
    );
    expect(result).toEqual({ ok: false, reason: "invalid-token" });
  });

  it("returns not-found when the teacher no longer exists", async () => {
    const token = signNotificationSettingsToken(
      { recipientId: TEACHER_ID, recipientType: "teacher", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ teacher: null }), secret: SECRET },
      token,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("returns not-found when the student's roster link to that teacher is gone", async () => {
    student.teacherIds = new Set([OTHER_TEACHER_ID]);
    const token = signNotificationSettingsToken(
      { recipientId: STUDENT_ROSTER_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ student }), secret: SECRET },
      token,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a teacher token whose recipientId doesn't match its own teacherId", async () => {
    const token = signNotificationSettingsToken(
      { recipientId: TEACHER_ID, recipientType: "teacher", teacherId: OTHER_TEACHER_ID },
      SECRET,
    );
    const result = await resolveNotificationSettingsLink(
      { prisma: buildPrisma({ teacher }), secret: SECRET },
      token,
    );
    expect(result).toEqual({ ok: false, reason: "invalid-token" });
  });
});
