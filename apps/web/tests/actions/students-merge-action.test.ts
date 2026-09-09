import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher duplicate-merge action wrapper. The merge engine is covered in
// lib/students/merge; this verifies the shell: same-id refusal, refusal-code
// → localized copy, and the success path.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })) }));

const state = { result: { ok: true } as { ok: boolean; code?: string } };
const mergeCore = vi.fn(async () => state.result);
vi.mock("@/lib/students/merge", () => ({ mergeRosterStudents: mergeCore }));

const { mergeRosterStudents } = await import("@/app/actions/students-merge");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function fd(keep: string, merge: string): FormData {
  const f = new FormData();
  f.set("keepStudentId", keep);
  f.set("mergeStudentId", merge);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.result = { ok: true };
});

describe("mergeRosterStudents action", () => {
  it("refuses identical keep/merge ids", async () => {
    const res = await mergeRosterStudents(undefined, fd(A, A));
    expect(res).toHaveProperty("error");
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it.each(["not_on_roster", "two_logins", "other_teacher", "pending_deletion", "failed"])(
    "maps the %s refusal to localized copy",
    async (code) => {
      state.result = { ok: false, code };
      const res = await mergeRosterStudents(undefined, fd(A, B));
      expect(res?.error).toBeTruthy();
    },
  );

  it("returns a success message on a completed merge", async () => {
    const res = await mergeRosterStudents(undefined, fd(A, B));
    expect(res?.ok).toBeTruthy();
    expect(mergeCore).toHaveBeenCalledWith({
      teacherId: "t1",
      keepStudentId: A,
      mergeStudentId: B,
    });
  });
});
