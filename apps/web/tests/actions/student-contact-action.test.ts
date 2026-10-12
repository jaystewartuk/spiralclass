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
    locale: "es",
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

const {
  updateMyContactInfoAction,
  updateStudentContactAsTeacherAction,
  requestEmailChangeAction,
  switchMyTimezoneAction,
} = await import("@/app/actions/student-contact");

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

  // A teacher whose student moved from Vienna to Toronto had no way to say so:
  // the form had no zone and the action dropped one.
  it("passes the time zone the teacher picked through to the update", async () => {
    await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Catarina",
        email: "",
        phone: "",
        timezone: "America/Toronto",
      }),
    );
    expect(applyStudentContactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "teacher", teacherId: "t1" },
        patch: expect.objectContaining({ timezone: "America/Toronto" }),
      }),
    );
  });

  it("leaves the zone alone when the teacher's form sends none", async () => {
    await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Catarina",
        email: "",
        phone: "",
        timezone: "",
      }),
    );
    const [[call]] = applyStudentContactUpdate.mock.calls as unknown as [
      [{ patch: Record<string, unknown> }],
    ];
    expect(call.patch).not.toHaveProperty("timezone");
  });

  it("refuses a zone that is not a real IANA id", async () => {
    const res = await updateStudentContactAsTeacherAction(
      undefined,
      form({
        studentId: "22222222-2222-4222-8222-222222222222",
        name: "Catarina",
        email: "",
        phone: "",
        timezone: "Mars/Olympus_Mons",
      }),
    );
    expect(res).toHaveProperty("error");
    expect(applyStudentContactUpdate).not.toHaveBeenCalled();
  });
});

describe("switchMyTimezoneAction", () => {
  it("saves the device's zone for the signed-in student, as her own change", async () => {
    const res = await switchMyTimezoneAction("America/Toronto");
    expect(res?.ok).toBeTruthy();
    expect(applyStudentContactUpdate).toHaveBeenCalledWith({
      studentId: "s1",
      actor: { type: "student" },
      patch: { timezone: "America/Toronto" },
    });
  });

  it("refuses an empty or unknown zone without touching the row", async () => {
    expect(await switchMyTimezoneAction("")).toHaveProperty("error");
    expect(await switchMyTimezoneAction("Not/AZone")).toHaveProperty("error");
    expect(applyStudentContactUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed update rather than claiming success", async () => {
    state.contactResult = { ok: false, error: "not-found" };
    const res = await switchMyTimezoneAction("America/Toronto");
    expect(res).toHaveProperty("error");
    expect(res).not.toHaveProperty("ok");
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
