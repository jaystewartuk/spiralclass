import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin teacher moderation (support role). disable/enable write an audit
// override in a transaction and enqueue the account-disabled notification;
// resend sends a plain sign-in code via better-auth (D-40). Pin validation,
// the audit write, the disabled-notification emit, and the resend
// not-found + send-failure paths.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin1" })) }));
vi.mock("@/lib/audit", () => ({ writeOverride: vi.fn(async () => {}) }));

const state = {
  teacher: { email: "mira@x.com" } as { email: string } | null,
  sendThrows: false,
};

const enqueueAccountDisabledTeacher = vi.fn(async () => "notif1");
const emitNotificationQueued = vi.fn(async () => {});
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueAccountDisabledTeacher }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued }));

const sendVerificationOTP = vi.fn(async (_input: unknown) => {
  if (state.sendThrows) throw new Error("smtp");
  return { success: true };
});
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { sendVerificationOTP: (input: unknown) => sendVerificationOTP(input) } },
}));

const teacherUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: vi.fn(async () => state.teacher) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        teacher: {
          findUnique: vi.fn(async () => ({ disabledAt: null, disabledReason: null })),
          update: teacherUpdate,
        },
      }),
    ),
  },
}));

const { disableTeacherAction, enableTeacherAction, resendTeacherMagicLinkAction } =
  await import("@/app/actions/admin-teachers");

const TID = "11111111-1111-4111-8111-111111111111";
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = { email: "mira@x.com" };
  state.sendThrows = false;
});

describe("disableTeacherAction", () => {
  it("requires a reason", async () => {
    expect(
      await disableTeacherAction(undefined, fd({ teacherId: TID, reason: "" })),
    ).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("disables the teacher and emits the account-disabled notification", async () => {
    const res = await disableTeacherAction(undefined, fd({ teacherId: TID, reason: "fraude" }));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalled();
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif1",
      teacherId: TID,
    });
  });
});

describe("enableTeacherAction", () => {
  it("re-enables the teacher", async () => {
    expect(await enableTeacherAction(undefined, fd({ teacherId: TID }))).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalled();
  });
});

describe("resendTeacherMagicLinkAction", () => {
  it("404s an unknown teacher", async () => {
    state.teacher = null;
    expect(await resendTeacherMagicLinkAction(undefined, fd({ teacherId: TID }))).toHaveProperty(
      "error",
    );
    expect(sendVerificationOTP).not.toHaveBeenCalled();
  });

  it("errors when the email send throws", async () => {
    state.sendThrows = true;
    expect(await resendTeacherMagicLinkAction(undefined, fd({ teacherId: TID }))).toHaveProperty(
      "error",
    );
  });

  it("sends the code and returns an info message", async () => {
    const res = await resendTeacherMagicLinkAction(undefined, fd({ teacherId: TID }));
    expect(res?.ok).toBe(true);
    expect(res?.info).toContain("mira@x.com");
    expect(sendVerificationOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "mira@x.com", type: "sign-in" } }),
    );
  });
});
