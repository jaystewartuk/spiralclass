import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin student moderation. All gate on requireAdmin("support"). Pin: input
// validation, the disable/enable transaction writing an audit override only
// when an audit-scope teacher exists, and the email-change result mapping.

const state = {
  auditTeacherId: "t1" as string | null,
  emailResult: { ok: true } as { ok: boolean; error?: string },
};

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1" })),
  isBootstrapActor: () => false,
}));

const writeOverride = vi.fn(async () => {});
vi.mock("@/lib/audit", () => ({ writeOverride }));

const adminSetStudentEmail = vi.fn(async () => state.emailResult);
vi.mock("@/lib/students/email-change", () => ({ adminSetStudentEmail }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const studentUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findFirst: vi.fn(async () =>
        state.auditTeacherId ? { teacherId: state.auditTeacherId } : null,
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        student: {
          findUnique: vi.fn(async () => ({ disabledAt: null, disabledReason: null })),
          update: studentUpdate,
        },
      }),
    ),
  },
}));

const { disableStudentAction, enableStudentAction, adminChangeStudentEmailAction } =
  await import("@/app/actions/admin-students");

const SID = "33333333-3333-4333-8333-333333333333";
function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auditTeacherId = "t1";
  state.emailResult = { ok: true };
});

describe("disableStudentAction", () => {
  it("requires a reason", async () => {
    expect(
      await disableStudentAction(undefined, form({ studentId: SID, reason: "" })),
    ).toHaveProperty("error");
    expect(studentUpdate).not.toHaveBeenCalled();
  });

  it("disables the student and writes an audit override", async () => {
    const res = await disableStudentAction(undefined, form({ studentId: SID, reason: "spam" }));
    expect(res).toEqual({ ok: true });
    expect(studentUpdate).toHaveBeenCalled();
    expect(writeOverride).toHaveBeenCalledTimes(1);
  });

  it("skips the audit override when the student has no teacher", async () => {
    state.auditTeacherId = null;
    const res = await disableStudentAction(undefined, form({ studentId: SID, reason: "spam" }));
    expect(res).toEqual({ ok: true });
    expect(writeOverride).not.toHaveBeenCalled();
  });
});

describe("enableStudentAction", () => {
  it("re-enables the student", async () => {
    const res = await enableStudentAction(undefined, form({ studentId: SID }));
    expect(res).toEqual({ ok: true });
    const data = studentUpdate.mock.calls[0][0].data as { disabledAt: Date | null };
    expect(data.disabledAt).toBeNull();
  });
});

describe("adminChangeStudentEmailAction", () => {
  it("rejects an invalid email", async () => {
    expect(
      await adminChangeStudentEmailAction(undefined, form({ studentId: SID, newEmail: "nope" })),
    ).toHaveProperty("error");
    expect(adminSetStudentEmail).not.toHaveBeenCalled();
  });

  it.each(["not-found", "email-taken", "unavailable"])(
    "maps the %s failure to an error",
    async (code) => {
      state.emailResult = { ok: false, error: code };
      expect(
        await adminChangeStudentEmailAction(
          undefined,
          form({ studentId: SID, newEmail: "new@x.com" }),
        ),
      ).toHaveProperty("error");
    },
  );

  it("succeeds on a valid change", async () => {
    const res = await adminChangeStudentEmailAction(
      undefined,
      form({ studentId: SID, newEmail: "new@x.com" }),
    );
    expect(res).toEqual({ ok: true });
  });
});
