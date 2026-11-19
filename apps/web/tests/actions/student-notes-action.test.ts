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
// The note rows, id → owner. Prisma semantics on the tenant key: absent (or
// `undefined`) is no filter, present must match; a `delete` miss throws (P2025)
// and a `findUnique` miss is null.
const noteRows = new Map<string, { teacherId: string; studentId: string }>();
function matchNote(where: { id: string; teacherId?: string }) {
  const row = noteRows.get(where.id);
  if (!row || (where.teacherId !== undefined && row.teacherId !== where.teacherId)) return null;
  return row;
}
const findUnique = vi.fn(async ({ where }: { where: { id: string; teacherId?: string } }) => {
  const row = matchNote(where);
  return row ? { studentId: row.studentId } : null;
});
const findFirst = vi.fn(async () => state.note);
const del = vi.fn(async ({ where }: { where: { id: string; teacherId?: string } }) => {
  if (!matchNote(where)) throw new Error(`No record found for ${where.id}`);
  noteRows.delete(where.id);
  return {};
});
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
const NX = "33333333-3333-3333-3333-333333333333"; // another teacher's note

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
  noteRows.clear();
  noteRows.set(N, { teacherId: "t1", studentId: "s1" });
  noteRows.set(NX, { teacherId: "t2", studentId: "sX" });
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
    expect(del).toHaveBeenCalledWith({ where: { id: N, teacherId: "t1" } });
  });
});

// D-175 / #62: the post-edit read (which picks the page to refresh and the
// analytics student) and the hard delete used to name only the note id. Both
// now name the signed-in teacher, so neither can reach another teacher's note.
describe("note reads and deletes are scoped to the signed-in teacher", () => {
  it("the post-edit read names the teacher", async () => {
    await updateStudentNote(undefined, fd({ noteId: N, body: "edited" }));
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: N, teacherId: "t1" },
      select: { studentId: true },
    });
  });

  it("the post-edit read never returns another teacher's student", async () => {
    // updateMany is mocked to report a match, standing in for a scope that
    // is later loosened; the read must still not surface the other teacher's row.
    await updateStudentNote(undefined, fd({ noteId: NX, body: "edited" }));
    expect(await findUnique.mock.results[0]!.value).toBeNull();
  });

  it("the delete names the teacher", async () => {
    await deleteStudentNote(undefined, fd({ noteId: N }));
    expect(del).toHaveBeenCalledWith({ where: { id: N, teacherId: "t1" } });
  });

  it("the delete never removes another teacher's note", async () => {
    // The ownership lookup is mocked to pass, standing in for one that is
    // later loosened or bypassed — the delete is the last line.
    await expect(deleteStudentNote(undefined, fd({ noteId: NX }))).rejects.toThrow(
      /No record found/,
    );
    expect(noteRows.has(NX)).toBe(true);
  });
});
