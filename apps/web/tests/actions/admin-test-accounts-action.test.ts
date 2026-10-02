import { beforeEach, describe, expect, it, vi } from "vitest";

// Marking a teacher or a student as an operator's test account (D-192). The
// only write path for `testAccount`: admin-gated, a reason required, and the
// audit row written in the same transaction as the change.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const requireAdmin = vi.fn(async () => ({ id: "admin1" }));
vi.mock("@/lib/admin", () => ({ requireAdmin: () => requireAdmin() }));
const writeOverride = vi.fn(async (_input: Record<string, unknown>) => "ov1");
vi.mock("@/lib/audit", () => ({
  writeOverride: (input: Record<string, unknown>) => writeOverride(input),
}));

const state = { found: true as boolean, linkedTeacherId: "t-linked" as string | null };
const teacherUpdate = vi.fn(async (_args: unknown) => ({}));
const studentUpdate = vi.fn(async (_args: unknown) => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        teacher: {
          findUnique: vi.fn(async () => (state.found ? { testAccount: false } : null)),
          update: teacherUpdate,
        },
        student: {
          findUnique: vi.fn(async () => (state.found ? { testAccount: false } : null)),
          update: studentUpdate,
        },
        teacherStudent: {
          findFirst: vi.fn(async () =>
            state.linkedTeacherId ? { teacherId: state.linkedTeacherId } : null,
          ),
        },
      }),
    ),
  },
}));

const { setTestAccountAction } = await import("@/app/actions/admin-test-accounts");

const ID = "11111111-1111-4111-8111-111111111111";
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.found = true;
  state.linkedTeacherId = "t-linked";
});

describe("setTestAccountAction", () => {
  it("is admin-only", async () => {
    await setTestAccountAction(
      undefined,
      fd({ target: "teacher", id: ID, testAccount: "true", reason: "my sandbox" }),
    );
    expect(requireAdmin).toHaveBeenCalled();
  });

  it("requires a reason, and changes nothing without one", async () => {
    const res = await setTestAccountAction(
      undefined,
      fd({ target: "student", id: ID, testAccount: "true", reason: " " }),
    );
    expect(res).toHaveProperty("error");
    expect(studentUpdate).not.toHaveBeenCalled();
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("marks a teacher and audits it against that teacher", async () => {
    const res = await setTestAccountAction(
      undefined,
      fd({ target: "teacher", id: ID, testAccount: "true", reason: "my sandbox" }),
    );
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({ where: { id: ID }, data: { testAccount: true } });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: ID,
        targetType: "teacher",
        action: "mark_test_account",
        reason: "my sandbox",
        before: { testAccount: false },
        after: { testAccount: true },
      }),
    );
  });

  it("marks a student, audited against the teacher it was last linked to", async () => {
    await setTestAccountAction(
      undefined,
      fd({ target: "student", id: ID, testAccount: "true", reason: "booking her funnel" }),
    );
    expect(studentUpdate).toHaveBeenCalledWith({ where: { id: ID }, data: { testAccount: true } });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t-linked", targetType: "student" }),
    );
  });

  it("still audits a student linked to no teacher", async () => {
    state.linkedTeacherId = null;
    await setTestAccountAction(
      undefined,
      fd({ target: "student", id: ID, testAccount: "false", reason: "real after all" }),
    );
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: null, action: "unmark_test_account" }),
    );
  });

  it("reports an unknown id instead of writing", async () => {
    state.found = false;
    const res = await setTestAccountAction(
      undefined,
      fd({ target: "teacher", id: ID, testAccount: "true", reason: "x" }),
    );
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });
});
