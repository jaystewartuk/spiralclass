import { beforeEach, describe, expect, it, vi } from "vitest";

// Student-contact actions. The mutation core (applyStudentContactUpdate) and
// the email-change flow are covered separately; this verifies the action
// shells: validation, the contact-error→message mapping, the disabled-account
// refusal + rate-limit on email change, and the email-change result mapping.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({
    id: "s1",
    authUserId: "u1",
    email: "old@x.com",
    locale: "es-MX",
    disabledAt: state.disabledAt,
  })),
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", country: "MX" })),
}));

const applyStudentContactUpdate = vi.fn(async () => state.contactResult);
vi.mock("@/lib/students/contact", () => ({ applyStudentContactUpdate }));

const requestStudentEmailChange = vi.fn(async () => state.emailResult);
vi.mock("@/lib/students/email-change", () => ({ requestStudentEmailChange }));

const rateLimit = vi.fn(async () => state.rl);
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));

const state = {
  disabledAt: null as Date | null,
  contactResult: { ok: true } as { ok: boolean; error?: string },
  emailResult: { ok: true, pendingEmail: "new@x.com" } as {
    ok: boolean;
    pendingEmail?: string;
    error?: string;
  },
  rl: { ok: true } as { ok: boolean },
};

const { updateMyContactInfoAction, updateStudentContactAsTeacherAction, requestEmailChangeAction } =
  await import("@/app/actions/student-contact");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.disabledAt = null;
  state.contactResult = { ok: true };
  state.emailResult = { ok: true, pendingEmail: "new@x.com" };
  state.rl = { ok: true };
});

describe("updateMyContactInfoAction", () => {
  it("saves valid contact details", async () => {
    const res = await updateMyContactInfoAction(undefined, form({ name: "Mira", phone: "" }));
    expect(res?.ok).toBeTruthy();
    expect(applyStudentContactUpdate).toHaveBeenCalled();
  });

  it("maps an email-locked update failure to a message", async () => {
    state.contactResult = { ok: false, error: "email-locked" };
    const res = await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Mira",
        email: "",
        phone: "",
      }),
    );
    expect(res?.error).toMatch(/sign|inicia/i);
  });

  it("passes the form's phoneCountry through to the update patch", async () => {
    await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Mira",
        email: "",
        phone: "7911123456",
        phoneCountry: "GB",
      }),
    );
    expect(applyStudentContactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ phoneCountry: "GB" }) }),
    );
  });

  it("falls back to the teacher's own country when the form omits phoneCountry", async () => {
    await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Mira",
        email: "",
        phone: "5512345678",
      }),
    );
    expect(applyStudentContactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ phoneCountry: "MX" }) }),
    );
  });
});

describe("requestEmailChangeAction", () => {
  it("refuses a disabled account", async () => {
    state.disabledAt = new Date();
    const res = await requestEmailChangeAction(undefined, form({ newEmail: "new@x.com" }));
    expect(res).toHaveProperty("error");
    expect(requestStudentEmailChange).not.toHaveBeenCalled();
  });

  it("rejects an invalid email before rate-limiting", async () => {
    const res = await requestEmailChangeAction(undefined, form({ newEmail: "nope" }));
    expect(res).toHaveProperty("error");
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("blocks once the rate limit is exceeded", async () => {
    state.rl = { ok: false };
    const res = await requestEmailChangeAction(undefined, form({ newEmail: "new@x.com" }));
    expect(res).toHaveProperty("error");
    expect(requestStudentEmailChange).not.toHaveBeenCalled();
  });

  it("returns the pending email on success", async () => {
    const res = await requestEmailChangeAction(undefined, form({ newEmail: "new@x.com" }));
    expect(res).toEqual({ pendingEmail: "new@x.com" });
  });

  it("maps a same-email failure to a friendly error", async () => {
    state.emailResult = { ok: false, error: "same-email" };
    const res = await requestEmailChangeAction(undefined, form({ newEmail: "new@x.com" }));
    expect(res).toHaveProperty("error");
  });
});
