import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher-private student notes. The security-relevant part is that every
// action scopes on teacher_id (tenant isolation): a teacher can only note their own
// students and can only edit/delete their own notes. Also pinned: notes are
// never written to the student-visible `overrides` audit table.

const state = {
  link: { teacherId: "t1" } as { teacherId: string } | null,
  note: { studentId: "s1" } as { studentId: string } | null,
  updateCount: 1,
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(),
}));

const create = vi.fn(async () => ({ id: "n1" }));
const updateMany = vi.fn(async () => ({ count: state.updateCount }));
const findUnique = vi.fn(async () => state.note);
const findFirst = vi.fn(async () => state.note);
const del = vi.fn(async () => ({}));
const linkFindUnique = vi.fn(async () => state.link);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    studentNote: { create, updateMany, findUnique, findFirst, delete: del },
    teacherStudent: { findUnique: linkFindUnique },
  },
}));

const { addStudentNote, updateStudentNote, deleteStudentNote } =
  await import("@/app/actions/student-notes");

const S = "11111111-1111-1111-1111-111111111111"; // valid uuid
const N = "22222222-2222-2222-2222-222222222222";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.link = { teacherId: "t1" };
  state.note = { studentId: "s1" };
  state.updateCount = 1;
});

describe("addStudentNote", () => {
  it("rejects an empty body", async () => {
    const res = await addStudentNote(undefined, fd({ studentId: S, body: "  " }));
    expect(res?.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a student that isn't on the teacher's roster", async () => {
    state.link = null;
    const res = await addStudentNote(undefined, fd({ studentId: S, body: "focus on past tense" }));
    expect(res?.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the note scoped to the teacher", async () => {
    const res = await addStudentNote(undefined, fd({ studentId: S, body: "focus on past tense" }));
    expect(res?.ok).toBeTruthy();
    expect(create).toHaveBeenCalledWith({
      data: { teacherId: "t1", studentId: S, body: "focus on past tense" },
    });
  });
});

describe("updateStudentNote", () => {
  it("scopes the update by teacher_id and reports not-found when nothing matched", async () => {
    state.updateCount = 0;
    const res = await updateStudentNote(undefined, fd({ noteId: N, body: "edited" }));
    expect(res?.error).toBeTruthy();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: N, teacherId: "t1" },
      data: { body: "edited" },
    });
  });

  it("updates a matching note", async () => {
    const res = await updateStudentNote(undefined, fd({ noteId: N, body: "edited" }));
    expect(res?.ok).toBeTruthy();
  });
});

describe("deleteStudentNote", () => {
  it("refuses to delete a note the teacher doesn't own", async () => {
    state.note = null;
    const res = await deleteStudentNote(undefined, fd({ noteId: N }));
    expect(res?.error).toBeTruthy();
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes a note the teacher owns", async () => {
    const res = await deleteStudentNote(undefined, fd({ noteId: N }));
    expect(res?.ok).toBeTruthy();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: N, teacherId: "t1" },
      select: { studentId: true },
    });
    expect(del).toHaveBeenCalledWith({ where: { id: N } });
  });
});
