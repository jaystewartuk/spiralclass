import { beforeEach, describe, expect, it, vi } from "vitest";

// Verified teacher email change (src/lib/teachers/email-change.ts), on
// better-auth's emailOTP changeEmail endpoints (D-40) — the teacher twin of
// the student flow. Teacher.id == user.id, so the row move is a single-row
// update keyed on that id (no identity-set fan-out). Asserts:
//   1. request: auth.api.requestEmailChangeEmailOTP called with the new
//      email, same-email rejected before calling out, and API errors
//      collapsed to a generic "unavailable" (anti-enumeration) while a
//      non-API throw surfaces as "send-failed".
//   2. verify: auth.api.changeEmailEmailOTP called with the code, success
//      syncs the Teacher row via syncTeacherEmailFromAuth; a bad code maps to
//      "invalid-code".
//   3. sync: only fires when auth and row emails disagree; moves the row;
//      old inbox gets the security notice; a notice failure never throws.
//   4. Google/OAuth identity security (the account-takeover regression this
//      guards): a successful verify ALWAYS disconnects any linked OAuth
//      account and revokes other sessions — see lib/auth/identity-change.ts
//      — before syncing the row, and reports googleDisconnected so the UI can
//      warn the teacher. See tests/lib/identity-change.test.ts for the
//      underlying Prisma/better-auth mechanics this test only asserts are
//      CALLED, not re-implemented.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

type TeacherRow = { id: string; email: string | null; locale: string };

class FakeAPIError extends Error {}

const state: {
  teacher: TeacherRow | null;
  sentEmails: Array<{ to: string; subject: string; body: string }>;
  emailSendOk: boolean;
  requestEmailChangeCalls: Array<{ body: unknown }>;
  requestEmailChangeError: Error | null;
  changeEmailCalls: Array<{ body: unknown }>;
  changeEmailError: Error | null;
  updated: Array<{ id: string; data: Record<string, unknown> }>;
  disconnectedProviders: string[];
  revokeOtherSessionsCalls: number;
} = {
  teacher: null,
  sentEmails: [],
  emailSendOk: true,
  requestEmailChangeCalls: [],
  requestEmailChangeError: null,
  changeEmailCalls: [],
  changeEmailError: null,
  updated: [],
  disconnectedProviders: [],
  revokeOtherSessionsCalls: 0,
};

function freshState() {
  state.teacher = { id: TEACHER_ID, email: "old@example.com", locale: "es-MX" };
  state.sentEmails = [];
  state.emailSendOk = true;
  state.requestEmailChangeCalls = [];
  state.requestEmailChangeError = null;
  state.changeEmailCalls = [];
  state.changeEmailError = null;
  state.updated = [];
  state.disconnectedProviders = [];
  state.revokeOtherSessionsCalls = 0;
}

const trackServerEventMock = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("better-auth/api", () => ({ APIError: FakeAPIError }));

vi.mock("@/lib/auth/server", () => ({
  auth: {
    api: {
      requestEmailChangeEmailOTP: async (input: { body: unknown }) => {
        state.requestEmailChangeCalls.push(input);
        if (state.requestEmailChangeError) throw state.requestEmailChangeError;
        return { success: true };
      },
      changeEmailEmailOTP: async (input: { body: unknown }) => {
        state.changeEmailCalls.push(input);
        if (state.changeEmailError) throw state.changeEmailError;
        return { success: true };
      },
    },
  },
}));

const disconnectOAuthAccounts = vi.fn(async (_userId: string) => ({
  disconnectedProviders: state.disconnectedProviders,
}));
const revokeOtherSessionsBestEffort = vi.fn(async () => {
  state.revokeOtherSessionsCalls += 1;
});
vi.mock("@/lib/auth/identity-change", () => ({
  disconnectOAuthAccounts: (userId: string) => disconnectOAuthAccounts(userId),
  revokeOtherSessionsBestEffort: () => revokeOtherSessionsBestEffort(),
}));

vi.mock("@/lib/email", () => ({
  getEmailClient: () => ({
    send: async (input: { to: string; subject: string; body: string }) => {
      state.sentEmails.push(input);
      return state.emailSendOk ? { ok: true } : { ok: false, error: "smtp down" };
    },
  }),
}));

vi.mock("@/lib/email/html-shell", () => ({
  renderBrandedEmailHtml: () => "<html>stub</html>",
}));

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://app.test" }) }));

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: async (args: { where: { id: string } }) =>
        state.teacher && state.teacher.id === args.where.id ? { ...state.teacher } : null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updated.push({ id: args.where.id, data: args.data });
        if (state.teacher && state.teacher.id === args.where.id) {
          Object.assign(state.teacher, args.data);
        }
        return { ...(state.teacher as TeacherRow) };
      },
    },
  },
}));

const { requestTeacherEmailChange, verifyTeacherEmailChange, syncTeacherEmailFromAuth } =
  await import("@/lib/teachers/email-change");

beforeEach(() => {
  freshState();
  trackServerEventMock.mockClear();
  disconnectOAuthAccounts.mockClear();
  revokeOtherSessionsBestEffort.mockClear();
});

describe("requestTeacherEmailChange", () => {
  const baseInput = () => ({
    teacher: { id: TEACHER_ID, email: "old@example.com" },
    newEmail: " New@Example.com ",
  });

  it("sends a change-email code to the new address", async () => {
    const result = await requestTeacherEmailChange(baseInput());
    expect(result).toEqual({ ok: true, pendingEmail: "new@example.com" });
    expect(state.requestEmailChangeCalls).toHaveLength(1);
    expect(state.requestEmailChangeCalls[0]).toMatchObject({
      body: { newEmail: "new@example.com" },
    });
  });

  it("rejects the current address, case-insensitively, without calling out", async () => {
    const result = await requestTeacherEmailChange({
      ...baseInput(),
      newEmail: "  OLD@example.com",
    });
    expect(result).toEqual({ ok: false, error: "same-email" });
    expect(state.requestEmailChangeCalls).toHaveLength(0);
  });

  it("collapses an API error (e.g. same email server-side) to a generic error", async () => {
    state.requestEmailChangeError = new FakeAPIError("same email");
    const result = await requestTeacherEmailChange(baseInput());
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("reports a send failure so the teacher can retry", async () => {
    state.requestEmailChangeError = new Error("network down");
    const result = await requestTeacherEmailChange(baseInput());
    expect(result).toEqual({ ok: false, error: "send-failed" });
  });
});

describe("verifyTeacherEmailChange", () => {
  it("verifies the code and syncs the Teacher row", async () => {
    const result = await verifyTeacherEmailChange({
      teacherId: TEACHER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: false });
    expect(state.changeEmailCalls[0]).toMatchObject({
      body: { newEmail: "new@example.com", otp: "123456" },
    });
    expect(state.teacher?.email).toBe("new@example.com");
  });

  it("maps an invalid/expired code to invalid-code", async () => {
    state.changeEmailError = new FakeAPIError("invalid otp");
    const result = await verifyTeacherEmailChange({
      teacherId: TEACHER_ID,
      newEmail: "new@example.com",
      otp: "000000",
    });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
    expect(state.teacher?.email).toBe("old@example.com");
    // An invalid code never flipped the identity, so nothing downstream
    // (the Google-takeover fix) should run either.
    expect(disconnectOAuthAccounts).not.toHaveBeenCalled();
    expect(revokeOtherSessionsBestEffort).not.toHaveBeenCalled();
  });

  // Regression test for the reported vulnerability: a teacher who signed up
  // via Google, then changed email in-app, could still be signed back in by
  // the ORIGINAL Google account afterward — because nothing ever removed the
  // linked Account row. A successful verify must always attempt to
  // disconnect any linked OAuth account and sign out every other session,
  // regardless of whether one actually existed.
  it("disconnects any linked Google/OAuth account and revokes other sessions on success", async () => {
    state.disconnectedProviders = ["google"];
    const result = await verifyTeacherEmailChange({
      teacherId: TEACHER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: true });
    expect(disconnectOAuthAccounts).toHaveBeenCalledWith(TEACHER_ID);
    expect(revokeOtherSessionsBestEffort).toHaveBeenCalledTimes(1);
    // The old-inbox notice must know Google was disconnected, so its copy
    // explains why "Sign in with Google" stopped working.
    expect(state.sentEmails[0].body).toContain("Google");
  });

  it("reports googleDisconnected: false when no OAuth account was linked", async () => {
    state.disconnectedProviders = [];
    const result = await verifyTeacherEmailChange({
      teacherId: TEACHER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: false });
    expect(disconnectOAuthAccounts).toHaveBeenCalledWith(TEACHER_ID);
    expect(state.sentEmails[0].body).not.toContain("Google");
  });
});

describe("syncTeacherEmailFromAuth", () => {
  it("no-ops when auth and row emails already agree (case-insensitive)", async () => {
    const moved = await syncTeacherEmailFromAuth({ id: TEACHER_ID, email: "OLD@example.com" });
    expect(moved).toBe(false);
    expect(state.updated).toHaveLength(0);
    expect(state.sentEmails).toHaveLength(0);
  });

  it("moves the row, notifies the old inbox, and tracks the event", async () => {
    const moved = await syncTeacherEmailFromAuth({ id: TEACHER_ID, email: "new@example.com" });
    expect(moved).toBe(true);
    expect(state.teacher?.email).toBe("new@example.com");
    expect(state.updated).toEqual([{ id: TEACHER_ID, data: { email: "new@example.com" } }]);

    expect(state.sentEmails).toHaveLength(1);
    expect(state.sentEmails[0].to).toBe("old@example.com");
    expect(state.sentEmails[0].body).toContain("new@example.com");

    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_email_updated",
        distinctId: TEACHER_ID,
        properties: expect.objectContaining({ actorType: "teacher" }),
      }),
    );
  });

  it("a notice failure is best-effort — the row stays moved and nothing throws", async () => {
    state.emailSendOk = false;
    const moved = await syncTeacherEmailFromAuth({ id: TEACHER_ID, email: "new@example.com" });
    expect(moved).toBe(true);
    expect(state.teacher?.email).toBe("new@example.com");
  });

  it("returns false for auth users with no teacher row", async () => {
    const moved = await syncTeacherEmailFromAuth({
      id: "99999999-9999-4999-8999-999999999999",
      email: "new@example.com",
    });
    expect(moved).toBe(false);
  });
});
