import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared testimonial CRUD core (lib/testimonials/store), used by both the
// web dashboard action. Covers input validation, default
// sort placement, teacher-scoped writes, the not-found path, and — the part
// that carries the verified badge on the public page — which of those writes
// may reach a student-submitted row.

const findFirst = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
// moveTestimonial renumbers the whole list inside one transaction; the mock
// just runs the operations it is handed.
const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transaction(...(a as [unknown[]])),
    testimonial: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import {
  addTestimonial,
  clearTestimonialPhoto,
  deleteStudentTestimonial,
  deleteTestimonial,
  isVerified,
  moveTestimonial,
  setTestimonialPublished,
  studentTestimonialInputSchema,
  testimonialInputSchema,
  updateTestimonial,
  upsertStudentTestimonial,
} from "@/lib/testimonials/store";
import { TESTIMONIAL_BODY_MAX } from "@/lib/testimonials/limits";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  findFirst.mockReset();
  findMany.mockReset();
  transaction.mockClear();
  create.mockReset();
  update.mockReset();
  updateMany.mockReset();
  deleteMany.mockReset();
});

describe("testimonialInputSchema", () => {
  it("trims name, note and body", () => {
    const parsed = testimonialInputSchema.parse({
      authorName: "  Mira  ",
      authorNote: "  B2 · 6 months  ",
      body: "  Great classes  ",
    });
    expect(parsed.authorName).toBe("Mira");
    expect(parsed.authorNote).toBe("B2 · 6 months");
    expect(parsed.body).toBe("Great classes");
  });

  it("rejects an empty name or body", () => {
    expect(testimonialInputSchema.safeParse({ authorName: "", body: "x" }).success).toBe(false);
    expect(testimonialInputSchema.safeParse({ authorName: "Mira", body: "" }).success).toBe(false);
  });

  it("rejects an over-long body", () => {
    const long = "x".repeat(TESTIMONIAL_BODY_MAX + 1);
    expect(testimonialInputSchema.safeParse({ authorName: "Mira", body: long }).success).toBe(
      false,
    );
  });
});

describe("addTestimonial", () => {
  it("places a new item after the current max sortOrder", async () => {
    findFirst.mockResolvedValue({ sortOrder: 4 });
    create.mockResolvedValue({ id: ID });
    await addTestimonial(TEACHER, { authorName: "Mira", authorNote: undefined, body: "Hi" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ teacherId: TEACHER, sortOrder: 5, authorNote: null }),
      }),
    );
  });

  it("starts at sortOrder 1 for the first testimonial", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: ID });
    await addTestimonial(TEACHER, { authorName: "Mira", authorNote: undefined, body: "Hi" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sortOrder: 1 }) }),
    );
  });

  it("persists a photoPath when provided", async () => {
    findFirst.mockResolvedValue({ sortOrder: 0 });
    create.mockResolvedValue({ id: ID });
    await addTestimonial(
      TEACHER,
      { authorName: "Mira", authorNote: undefined, body: "Hi" },
      `${TEACHER}/testimonials/${ID}`,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ photoPath: `${TEACHER}/testimonials/${ID}` }),
      }),
    );
  });

  it("stores photoPath as null when not provided", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: ID });
    await addTestimonial(TEACHER, { authorName: "Mira", authorNote: undefined, body: "Hi" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ photoPath: null }) }),
    );
  });
});

describe("updateTestimonial / setTestimonialPublished / deleteTestimonial", () => {
  it("scopes writes to the owning teacher and reports success", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const ok = await updateTestimonial(TEACHER, ID, {
      authorName: "Mira",
      authorNote: undefined,
      body: "Edited",
    });
    expect(ok).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ID, teacherId: TEACHER, source: "teacher_curated" },
      }),
    );
  });

  it("returns false when the row isn't the teacher's", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });
    expect(await setTestimonialPublished(TEACHER, ID, true)).toBe(false);
    expect(await deleteTestimonial(TEACHER, ID)).toBe(false);
  });

  it("toggles published with a teacher-scoped write", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await setTestimonialPublished(TEACHER, ID, false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, teacherId: TEACHER },
      data: { published: false },
    });
  });

  it("passes an explicit photoPath through to updateTestimonial", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await updateTestimonial(
      TEACHER,
      ID,
      { authorName: "Mira", authorNote: undefined, body: "Hi" },
      "new/photo/path",
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ photoPath: "new/photo/path" }),
      }),
    );
  });

  it("leaves photoPath unchanged when undefined is passed to updateTestimonial", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await updateTestimonial(TEACHER, ID, {
      authorName: "Mira",
      authorNote: undefined,
      body: "Hi",
    });
    // photoPath should NOT appear in the data
    const data = updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("photoPath");
  });

  it("clearTestimonialPhoto sets photoPath to null scoped by teacher", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const ok = await clearTestimonialPhoto(TEACHER, ID);
    expect(ok).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, teacherId: TEACHER, source: "teacher_curated" },
      data: { photoPath: null },
    });
  });
});

// --- The rules that make the public page's badge worth anything -------------
//
// Everything below is one claim in different clothes: the teacher's own writes
// cannot reach a student's words. A curated row she may edit freely; a verified
// row she may hide or delete, and nothing else. The database CHECK constraint
// in 20260902120000_verified_student_testimonials is the second lock — these
// tests cover the first.

const STUDENT = "33333333-3333-4333-8333-333333333333";

describe("teacher writes never reach a verified row", () => {
  it("addTestimonial can only ever create a curated row", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: ID });
    await addTestimonial(TEACHER, { authorName: "Mira", authorNote: undefined, body: "Hi" });
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.source).toBe("teacher_curated");
    // No way to smuggle a student id or a verification stamp through this path.
    expect(data).not.toHaveProperty("studentId");
    expect(data).not.toHaveProperty("verifiedAt");
  });

  it("updateTestimonial filters on source, so a verified row matches nothing", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const ok = await updateTestimonial(TEACHER, ID, {
      authorName: "Mira",
      authorNote: undefined,
      body: "Words she wishes the student had written",
    });
    expect(ok).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ source: "teacher_curated" });
  });

  it("clearTestimonialPhoto filters on source too", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await clearTestimonialPhoto(TEACHER, ID)).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ source: "teacher_curated" });
  });

  it("hiding and deleting stay unfiltered — both kinds are hers to remove", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    deleteMany.mockResolvedValue({ count: 1 });
    await setTestimonialPublished(TEACHER, ID, false);
    await deleteTestimonial(TEACHER, ID);
    expect(updateMany.mock.calls[0][0].where).not.toHaveProperty("source");
    expect(deleteMany.mock.calls[0][0].where).not.toHaveProperty("source");
  });
});

describe("studentTestimonialInputSchema", () => {
  it("accepts only a body — no name, note or photo to dress a quote up with", () => {
    const parsed = studentTestimonialInputSchema.parse({
      body: "  Six months in and I can hold a conversation.  ",
      authorName: "Someone Else",
      authorNote: "C1",
    });
    expect(parsed.body).toBe("Six months in and I can hold a conversation.");
    expect(parsed).not.toHaveProperty("authorName");
    expect(parsed).not.toHaveProperty("authorNote");
  });

  it("rejects an empty or over-long body, same limits as the curated form", () => {
    expect(studentTestimonialInputSchema.safeParse({ body: "" }).success).toBe(false);
    expect(
      studentTestimonialInputSchema.safeParse({ body: "x".repeat(TESTIMONIAL_BODY_MAX + 1) })
        .success,
    ).toBe(false);
  });
});

describe("upsertStudentTestimonial", () => {
  it("creates a published, verified row carrying the student id", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ sortOrder: 2 });
    create.mockResolvedValue({ id: ID });
    await upsertStudentTestimonial(TEACHER, STUDENT, "Mira", { body: "Worth every peso." });
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      teacherId: TEACHER,
      studentId: STUDENT,
      authorName: "Mira",
      source: "student_submitted",
      published: true,
      sortOrder: 3,
    });
    expect(data.verifiedAt).toBeInstanceOf(Date);
  });

  it("revises the existing row rather than adding a second one", async () => {
    findFirst.mockResolvedValue({ id: ID });
    update.mockResolvedValue({ id: ID });
    await upsertStudentTestimonial(TEACHER, STUDENT, "Mira", { body: "Still true a year later." });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ID },
        data: expect.objectContaining({ body: "Still true a year later.", authorName: "Mira" }),
      }),
    );
    // The stamp moves with the words: it dates the text on the page, not the
    // first time this student ever wrote one.
    expect((update.mock.calls[0][0].data as Record<string, unknown>).verifiedAt).toBeInstanceOf(
      Date,
    );
  });

  it("takes the displayed name from the caller, never from the submitted body", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    create.mockResolvedValue({ id: ID });
    await upsertStudentTestimonial(TEACHER, STUDENT, "Roster Name", { body: "— Someone Famous" });
    expect((create.mock.calls[0][0].data as Record<string, unknown>).authorName).toBe(
      "Roster Name",
    );
  });
});

describe("deleteStudentTestimonial", () => {
  it("is scoped by student, so it can only reach the row that student wrote", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteStudentTestimonial(TEACHER, STUDENT)).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { teacherId: TEACHER, studentId: STUDENT },
    });
  });
});

describe("isVerified", () => {
  it("reads the source, which is the column the CHECK constraint ties the rest to", () => {
    expect(isVerified({ source: "student_submitted" })).toBe(true);
    expect(isVerified({ source: "teacher_curated" })).toBe(false);
  });
});

describe("moveTestimonial", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  /** The (id, sortOrder) pairs written by the transaction, in write order. */
  function writes() {
    return updateMany.mock.calls.map((call) => [
      (call[0] as { where: { id: string } }).where.id,
      (call[0] as { data: { sortOrder: number } }).data.sortOrder,
    ]);
  }

  it("reads the list in the same order the public page does", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }]);
    updateMany.mockResolvedValue({ count: 1 });
    await moveTestimonial(TEACHER, B, "up");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    );
  });

  it("moves an item one place earlier and renumbers the whole list", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }, { id: C }]);
    updateMany.mockResolvedValue({ count: 1 });

    expect(await moveTestimonial(TEACHER, C, "up")).toBe(true);

    expect(writes()).toEqual([
      [A, 0],
      [C, 1],
      [B, 2],
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("moves an item one place later", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }, { id: C }]);
    updateMany.mockResolvedValue({ count: 1 });

    expect(await moveTestimonial(TEACHER, A, "down")).toBe(true);

    expect(writes()).toEqual([
      [B, 0],
      [A, 1],
      [C, 2],
    ]);
  });

  // The renumber is what makes a move work at all when two rows tie on
  // sortOrder — a swap of the two values would be a no-op there.
  it("still reorders when every row shares a sortOrder", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }]);
    updateMany.mockResolvedValue({ count: 1 });

    expect(await moveTestimonial(TEACHER, B, "up")).toBe(true);
    expect(writes()).toEqual([
      [B, 0],
      [A, 1],
    ]);
  });

  it("writes nothing at either end of the list", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }]);

    expect(await moveTestimonial(TEACHER, A, "up")).toBe(false);
    expect(await moveTestimonial(TEACHER, B, "down")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  // findMany is already scoped to the teacher, so another teacher's row is
  // simply absent from the list and can never be renumbered by this call.
  it("writes nothing for a row that is not this teacher's", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }]);

    expect(await moveTestimonial(TEACHER, C, "up")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("scopes every renumbering write by teacherId", async () => {
    findMany.mockResolvedValue([{ id: A }, { id: B }]);
    updateMany.mockResolvedValue({ count: 1 });

    await moveTestimonial(TEACHER, B, "up");
    for (const call of updateMany.mock.calls) {
      expect((call[0] as { where: { teacherId: string } }).where.teacherId).toBe(TEACHER);
    }
  });
});
