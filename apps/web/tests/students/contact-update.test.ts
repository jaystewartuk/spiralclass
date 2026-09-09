import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared contact-card mutation (src/lib/students/contact.ts) — the single
// path behind the student account page (web + mobile PATCH) and the
// teacher roster fix. Asserts:
//   1. The email guard: teacher-only, locked once authUserId is set,
//      lowercased, and unique within the teacher's roster.
//   2. One audit row per save with before/after limited to changed fields.
// 3. Tenancy: a teacher can't touch students off her roster.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_STUDENT_ID = "22222222-2222-4222-8222-cccccccccccc";
const AUTH_USER_ID = "33333333-3333-4333-8333-333333333333";

type StudentRow = {
  id: string;
  authUserId: string | null;
  email: string | null;
  name: string;
  phoneE164: string | null;
  timezone: string | null;
  teacherIds: string[];
};

type ContactChangeRow = {
  id: string;
  studentId: string;
  actorType: string;
  actorTeacherId: string | null;
  beforeJson: Record<string, unknown>;
  afterJson: Record<string, unknown>;
};

const state: { students: StudentRow[]; contactChanges: ContactChangeRow[] } = {
  students: [],
  contactChanges: [],
};

function freshState() {
  state.students.length = 0;
  state.contactChanges.length = 0;
  state.students.push({
    id: STUDENT_ID,
    authUserId: null,
    email: "marco@example.com",
    name: "Marco",
    phoneE164: null,
    timezone: null,
    teacherIds: [TEACHER_ID],
  });
  state.students.push({
    id: SIBLING_STUDENT_ID,
    authUserId: null,
    email: "lucia@example.com",
    name: "Lucía",
    phoneE164: null,
    timezone: null,
    teacherIds: [TEACHER_ID],
  });
}

const trackServerEventMock = vi.fn();

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  function snapshot<T>(row: T | null): T | null {
    return row ? ({ ...(row as object) } as T) : null;
  }
  function matches(s: StudentRow, where: any): boolean {
    if (where.id) {
      if (typeof where.id === "object" && where.id.not) {
        if (s.id === where.id.not) return false;
      } else if (s.id !== where.id) {
        return false;
      }
    }
    if (where.email !== undefined && s.email !== where.email) return false;
    if (where.teacherStudents?.some?.teacherId) {
      if (!s.teacherIds.includes(where.teacherStudents.some.teacherId)) return false;
    }
    return true;
  }
  function studentFindFirst({ where }: any) {
    return snapshot(state.students.find((s) => matches(s, where)) ?? null);
  }
  function studentUpdate({ where, data }: any) {
    const s = state.students.find((row) => row.id === where.id);
    if (!s) throw new Error(`no student ${where.id}`);
    Object.assign(s, data);
    return snapshot(s);
  }
  function contactChangeCreate({ data }: any) {
    const row: ContactChangeRow = {
      id: `change-${state.contactChanges.length + 1}`,
      ...data,
    };
    state.contactChanges.push(row);
    return row;
  }
  const tx = {
    student: { update: studentUpdate },
    studentContactChange: { create: contactChangeCreate },
  };
  return {
    prisma: {
      student: { findFirst: studentFindFirst },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { applyStudentContactUpdate } = await import("@/lib/students/contact");

function studentRow(id: string = STUDENT_ID): StudentRow {
  const row = state.students.find((s) => s.id === id);
  if (!row) throw new Error(`no student ${id}`);
  return row;
}

beforeEach(() => {
  freshState();
  trackServerEventMock.mockClear();
});

describe("student self-edit", () => {
  it("updates name + number, audits with actorType=student", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { name: "Marco A.", phoneE164: "+52 5512345678" },
    });
    expect(result.ok).toBe(true);
    const row = studentRow();
    expect(row.name).toBe("Marco A.");
    expect(row.phoneE164).toBe("+525512345678"); // normalized E.164

    expect(state.contactChanges).toHaveLength(1);
    expect(state.contactChanges[0]).toMatchObject({
      studentId: STUDENT_ID,
      actorType: "student",
      actorTeacherId: null,
      beforeJson: { name: "Marco", phoneE164: null },
      afterJson: { name: "Marco A.", phoneE164: "+525512345678" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "student_contact_updated",
        distinctId: STUDENT_ID,
      }),
    );
  });

  it("clearing the number persists null", async () => {
    Object.assign(studentRow(), { phoneE164: "+525512345678" });
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { phoneE164: null },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().phoneE164).toBeNull();
  });

  it("a no-op save writes no audit row and emits no event", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { name: "Marco", phoneE164: null },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toEqual([]);
    expect(state.contactChanges).toHaveLength(0);
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it("resolves a bare national number to the student's picked country, not the MX default", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { phoneE164: "4155550123", phoneCountry: "US" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().phoneE164).toBe("+14155550123");
  });

  it("falls back to the MX default when no phoneCountry hint is given", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { phoneE164: "5512345678" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().phoneE164).toBe("+525512345678");
  });

  it("cannot change email (locked to the verified flow)", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "student" },
      patch: { email: "new@example.com" },
    });
    expect(result).toEqual({ ok: false, error: "email-locked" });
    expect(studentRow().email).toBe("marco@example.com");
    expect(state.contactChanges).toHaveLength(0);
  });
});

describe("teacher roster edit", () => {
  it("fixes the email (lowercased) while the student has never signed in, audits with the teacher id", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { email: "Marco.Nuevo@Example.com" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().email).toBe("marco.nuevo@example.com");
    expect(state.contactChanges[0]).toMatchObject({
      actorType: "teacher",
      actorTeacherId: TEACHER_ID,
      beforeJson: { email: "marco@example.com" },
      afterJson: { email: "marco.nuevo@example.com" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: TEACHER_ID }),
    );
  });

  it("refuses the email edit once the student signs in (authUserId set)", async () => {
    studentRow().authUserId = AUTH_USER_ID;
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { email: "other@example.com" },
    });
    expect(result).toEqual({ ok: false, error: "email-locked" });
    expect(studentRow().email).toBe("marco@example.com");
  });

  it("still allows name/phone edits on a signed-in student", async () => {
    studentRow().authUserId = AUTH_USER_ID;
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { name: "Marco Antonio", phoneE164: "+525512345678" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().name).toBe("Marco Antonio");
    expect(studentRow().phoneE164).toBe("+525512345678");
  });

  it("re-submitting the student's current email is a no-op, not a lock error", async () => {
    studentRow().authUserId = AUTH_USER_ID;
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { name: "Marco", email: "marco@example.com" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toEqual([]);
  });

  it("rejects an email already used by another of the teacher's students", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { email: "lucia@example.com" },
    });
    expect(result).toEqual({ ok: false, error: "email-taken" });
    expect(studentRow().email).toBe("marco@example.com");
  });

  it("returns not-found for a student off the teacher's roster (tenant isolation)", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: OTHER_TEACHER_ID },
      patch: { name: "Hacked" },
    });
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(studentRow().name).toBe("Marco");
  });

  it("updates the number on behalf of the student", async () => {
    Object.assign(studentRow(), { phoneE164: "+525512345678" });
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { phoneE164: "+525599999999" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().phoneE164).toBe("+525599999999");
  });

  it("resolves a bare national number using the teacher's picked country", async () => {
    const result = await applyStudentContactUpdate({
      studentId: STUDENT_ID,
      actor: { type: "teacher", teacherId: TEACHER_ID },
      patch: { phoneE164: "7911123456", phoneCountry: "GB" },
    });
    expect(result.ok).toBe(true);
    expect(studentRow().phoneE164).toBe("+447911123456");
  });
});
