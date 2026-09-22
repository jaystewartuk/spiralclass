import { beforeEach, describe, expect, it, vi } from "vitest";

// A student grades a due vocabulary term (Phase F). Web wrapper over
// gradeVocabularyFor: pins the grade-enum validation, the identity-set scoping
// (a student can only touch their own review rows), the failure-reason
// passthrough, and the success revalidate.

const state = { grade: { ok: true as boolean, reason: undefined as string | undefined } };

vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({ id: "stu1" })),
}));

const studentIdentityIds = vi.fn(async () => ["stu1", "stu2"]);
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds }));

const gradeVocabularyFor = vi.fn(async () => state.grade);
vi.mock("@/lib/lesson-notes/student-progress", () => ({ gradeVocabularyFor }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { gradeVocabulary } = await import("@/app/actions/student-vocab");

beforeEach(() => {
  vi.clearAllMocks();
  state.grade = { ok: true, reason: undefined };
});

describe("gradeVocabulary", () => {
  it("rejects an invalid grade without touching the SRS core", async () => {
    // @ts-expect-error — deliberately passing an out-of-enum grade
    const res = await gradeVocabulary("rev1", "perfect");
    expect(res).toEqual({ error: "invalid-grade" });
    expect(gradeVocabularyFor).not.toHaveBeenCalled();
  });

  it("scopes the grade to the student's identity set", async () => {
    const res = await gradeVocabulary("rev1", "good");
    expect(res).toEqual({ ok: true });
    expect(gradeVocabularyFor).toHaveBeenCalledWith(
      expect.anything(),
      ["stu1", "stu2"],
      "rev1",
      "good",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/my-classes/progress");
  });

  it("passes a core failure reason straight back", async () => {
    state.grade = { ok: false, reason: "not-found" };
    const res = await gradeVocabulary("rev1", "again");
    expect(res).toEqual({ error: "not-found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
