import { beforeEach, describe, expect, it, vi } from "vitest";

// Verified email change (src/lib/students/email-change.ts), on better-auth's
// emailOTP changeEmail endpoints (D-40) — the flow that moves the auth
// identity and the Student row(s) together. Asserts:
//   1. request: auth.api.requestEmailChangeEmailOTP called with the new
//      email; refused for unlinked students; same-email rejected before
//      calling out; API errors collapse to "unavailable" (anti-enumeration)
//      while a non-API throw surfaces as "send-failed".
//   2. verify: auth.api.changeEmailEmailOTP called with the code; success
//      syncs every Student row via syncStudentEmailFromAuth; a bad code maps
//      to "invalid-code".
//   3. sync: only fires when auth and row emails disagree; moves every row
//      carrying the old address; one audit row per moved row; old inbox
//      gets the security notice; a notice failure never throws.
//   4. admin path (updates the better-auth `user` row directly via Prisma):
//      auth-first for linked students, roster-scoped uniqueness, row-only for
//      unlinked students.
//   5. Google/OAuth identity security (the account-takeover regression this
//      guards, see lib/auth/identity-change.ts): both the self-service verify
//      and the admin path disconnect any linked OAuth account and revoke
//      sessions on a successful change — self-service via
//      revokeOtherSessionsBestEffort (current-session-relative), admin via
//      revokeAllSessionsForUser (the caller is the ADMIN's session, not the
//      student's). Never runs for an unlinked student (nothing to disconnect).

const APP_URL = "https://app.test";
const AUTH_USER_ID = "33333333-3333-4333-8333-333333333333";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_ID = "22222222-2222-4222-8222-cccccccccccc";
const OTHER_ID = "22222222-2222-4222-8222-dddddddddddd";
const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const TEACHER_B = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const ADMIN_ID = "44444444-4444-4444-8444-444444444444";

type StudentRow = {
  id: string;
  authUserId: string | null;
  email: string | null;
  name: string;
  locale: string;
  teacherIds: string[];
};

const state: {
  students: StudentRow[];
  contactChanges: Array<{
    studentId: string;
    actorType: string;
    actorAdminId: string | null;
    beforeJson: Record<string, unknown>;
    afterJson: Record<string, unknown>;
  }>;
  sentEmails: Array<{ to: string; subject: string; body: string }>;
  emailSendOk: boolean;
  // The admin path updates the better-auth `user` row through Prisma
  // (user.update) — these track those calls for its assertions.
  updateUserByIdCalls: Array<{ id: string; attrs: Record<string, unknown> }>;
  updateUserByIdError: { status: number } | null;
} = {
  students: [],
  contactChanges: [],
  sentEmails: [],
  emailSendOk: true,
  updateUserByIdCalls: [],
  updateUserByIdError: null,
};

function freshState() {
  state.students = [
    {
      id: STUDENT_ID,
      authUserId: AUTH_USER_ID,
      email: "old@example.com",
      name: "Marco",
      locale: "es-MX",
      teacherIds: [TEACHER_A],
    },
    // Same person, second teacher: shares the inbox, must move together.
    {
      id: SIBLING_ID,
      authUserId: null,
      email: "old@example.com",
      name: "Marco",
      locale: "es-MX",
      teacherIds: [TEACHER_B],
    },
    // Unrelated student on teacher A's roster.
    {
      id: OTHER_ID,
      authUserId: null,
      email: "lucia@example.com",
      name: "Lucía",
      locale: "es-MX",
      teacherIds: [TEACHER_A],
    },
  ];
  state.contactChanges = [];
  state.sentEmails = [];
  state.emailSendOk = true;
  state.updateUserByIdCalls = [];
  state.updateUserByIdError = null;
  betterAuthState.requestEmailChangeCalls = [];
  betterAuthState.requestEmailChangeError = null;
  betterAuthState.changeEmailCalls = [];
  betterAuthState.changeEmailError = null;
  identityChangeState.disconnectedProviders = [];
  identityChangeState.revokeOtherSessionsCalls = 0;
  identityChangeState.revokeAllSessionsCalls = 0;
}

const trackServerEventMock = vi.fn();

class FakeAPIError extends Error {}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("better-auth/api", () => ({ APIError: FakeAPIError }));

const betterAuthState = {
  requestEmailChangeCalls: [] as Array<{ body: unknown }>,
  requestEmailChangeError: null as Error | null,
  changeEmailCalls: [] as Array<{ body: unknown }>,
  changeEmailError: null as Error | null,
};
vi.mock("@/lib/auth/server", () => ({
  auth: {
    api: {
      requestEmailChangeEmailOTP: async (input: { body: unknown }) => {
        betterAuthState.requestEmailChangeCalls.push(input);
        if (betterAuthState.requestEmailChangeError) throw betterAuthState.requestEmailChangeError;
        return { success: true };
      },
      changeEmailEmailOTP: async (input: { body: unknown }) => {
        betterAuthState.changeEmailCalls.push(input);
        if (betterAuthState.changeEmailError) throw betterAuthState.changeEmailError;
        return { success: true };
      },
    },
  },
}));

const identityChangeState = {
  disconnectedProviders: [] as string[],
  revokeOtherSessionsCalls: 0,
  revokeAllSessionsCalls: 0,
};
const disconnectOAuthAccounts = vi.fn(async (_userId: string) => ({
  disconnectedProviders: identityChangeState.disconnectedProviders,
}));
const revokeOtherSessionsBestEffort = vi.fn(async () => {
  identityChangeState.revokeOtherSessionsCalls += 1;
});
const revokeAllSessionsForUser = vi.fn(async (_userId: string) => {
  identityChangeState.revokeAllSessionsCalls += 1;
});
vi.mock("@/lib/auth/identity-change", () => ({
  disconnectOAuthAccounts: (userId: string) => disconnectOAuthAccounts(userId),
  revokeOtherSessionsBestEffort: () => revokeOtherSessionsBestEffort(),
  revokeAllSessionsForUser: (userId: string) => revokeAllSessionsForUser(userId),
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    APP_URL,
    NODE_ENV: "test",
  }),
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

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  function snapshot<T>(row: T | null): T | null {
    return row ? ({ ...(row as object) } as T) : null;
  }
  function matches(s: StudentRow, where: any): boolean {
    if (where.id) {
      if (typeof where.id === "object") {
        if (where.id.not && s.id === where.id.not) return false;
        if (where.id.in && !where.id.in.includes(s.id)) return false;
      } else if (s.id !== where.id) {
        return false;
      }
    }
    if (where.authUserId !== undefined && s.authUserId !== where.authUserId) return false;
    if (where.email !== undefined) {
      const want =
        typeof where.email === "object" && where.email !== null ? where.email.equals : where.email;
      const insensitive = typeof where.email === "object" && where.email?.mode === "insensitive";
      const have = s.email;
      if (want === null) {
        if (have !== null) return false;
      } else if (have === null) {
        return false;
      } else if (insensitive) {
        if (have.toLowerCase() !== String(want).toLowerCase()) return false;
      } else if (have !== want) {
        return false;
      }
    }
    if (where.teacherStudents?.some?.teacherId) {
      const cond = where.teacherStudents.some.teacherId;
      const wanted: string[] = typeof cond === "object" ? cond.in : [cond];
      if (!s.teacherIds.some((t) => wanted.includes(t))) return false;
    }
    return true;
  }
  function withSelectedRelations(s: StudentRow, args: any) {
    const row: Record<string, unknown> = { ...s };
    if (args?.select?.teacherStudents) {
      row.teacherStudents = s.teacherIds.map((teacherId) => ({ teacherId }));
    }
    return row;
  }
  function studentFindFirst(args: any) {
    const found = state.students.find((s) => matches(s, args.where));
    return found ? withSelectedRelations(found, args) : null;
  }
  function studentFindUnique(args: any) {
    const found = state.students.find((s) => s.id === args.where.id);
    return found ? withSelectedRelations(found, args) : null;
  }
  function studentFindMany(args: any) {
    return state.students.filter((s) => matches(s, args.where)).map((s) => snapshot(s));
  }
  function studentUpdateMany(args: any) {
    let count = 0;
    for (const s of state.students) {
      if (matches(s, args.where)) {
        Object.assign(s, args.data);
        count += 1;
      }
    }
    return { count };
  }
  function contactChangeCreateMany({ data }: any) {
    for (const row of data) state.contactChanges.push(row);
    return { count: data.length };
  }
  const tx = {
    student: { findMany: studentFindMany, updateMany: studentUpdateMany },
    studentContactChange: { createMany: contactChangeCreateMany },
  };
  function userUpdate({ where, data }: any) {
    state.updateUserByIdCalls.push({ id: where.id, attrs: data });
    if (state.updateUserByIdError) {
      const err = new Error("unique constraint") as Error & { code?: string };
      err.code = "P2002";
      throw err;
    }
    return { id: where.id, ...data };
  }
  return {
    prisma: {
      student: {
        findFirst: studentFindFirst,
        findUnique: studentFindUnique,
        findMany: studentFindMany,
        updateMany: studentUpdateMany,
      },
      user: { update: userUpdate },
      studentContactChange: { createMany: contactChangeCreateMany },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const {
  requestStudentEmailChange,
  verifyStudentEmailChange,
  syncStudentEmailFromAuth,
  adminSetStudentEmail,
} = await import("@/lib/students/email-change");

function student(id: string = STUDENT_ID): StudentRow {
  const row = state.students.find((s) => s.id === id);
  if (!row) throw new Error(`no student ${id}`);
  return row;
}

beforeEach(() => {
  freshState();
  trackServerEventMock.mockClear();
  disconnectOAuthAccounts.mockClear();
  revokeOtherSessionsBestEffort.mockClear();
  revokeAllSessionsForUser.mockClear();
});

describe("requestStudentEmailChange", () => {
  const baseInput = () => ({
    student: {
      id: STUDENT_ID,
      authUserId: AUTH_USER_ID,
      email: "old@example.com",
    },
    newEmail: " New@Example.com ",
  });

  it("sends a change-email code to the new address", async () => {
    const result = await requestStudentEmailChange(baseInput());
    expect(result).toEqual({ ok: true, pendingEmail: "new@example.com" });
    expect(betterAuthState.requestEmailChangeCalls).toHaveLength(1);
    expect(betterAuthState.requestEmailChangeCalls[0]).toMatchObject({
      body: { newEmail: "new@example.com" },
    });
  });

  it("refuses for unlinked students (no auth identity to move)", async () => {
    const result = await requestStudentEmailChange({
      ...baseInput(),
      student: { ...baseInput().student, authUserId: null },
    });
    expect(result).toEqual({ ok: false, error: "not-linked" });
    expect(betterAuthState.requestEmailChangeCalls).toHaveLength(0);
  });

  it("rejects the current address, case-insensitively, without calling out", async () => {
    const result = await requestStudentEmailChange({
      ...baseInput(),
      newEmail: "  OLD@example.com",
    });
    expect(result).toEqual({ ok: false, error: "same-email" });
    expect(betterAuthState.requestEmailChangeCalls).toHaveLength(0);
  });

  it("collapses an API error to a generic error", async () => {
    betterAuthState.requestEmailChangeError = new FakeAPIError("already in use");
    const result = await requestStudentEmailChange(baseInput());
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("reports a send failure so the student can retry", async () => {
    betterAuthState.requestEmailChangeError = new Error("network down");
    const result = await requestStudentEmailChange(baseInput());
    expect(result).toEqual({ ok: false, error: "send-failed" });
  });
});

describe("verifyStudentEmailChange", () => {
  it("verifies the code and syncs every Student row sharing the old inbox", async () => {
    const result = await verifyStudentEmailChange({
      studentAuthUserId: AUTH_USER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: false });
    expect(betterAuthState.changeEmailCalls[0]).toMatchObject({
      body: { newEmail: "new@example.com", otp: "123456" },
    });
    expect(student(STUDENT_ID).email).toBe("new@example.com");
    expect(student(SIBLING_ID).email).toBe("new@example.com");
  });

  it("maps an invalid/expired code to invalid-code", async () => {
    betterAuthState.changeEmailError = new FakeAPIError("invalid otp");
    const result = await verifyStudentEmailChange({
      studentAuthUserId: AUTH_USER_ID,
      newEmail: "new@example.com",
      otp: "000000",
    });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
    expect(student(STUDENT_ID).email).toBe("old@example.com");
    expect(disconnectOAuthAccounts).not.toHaveBeenCalled();
    expect(revokeOtherSessionsBestEffort).not.toHaveBeenCalled();
  });

  // Regression test for the reported vulnerability: a student who signed up
  // via Google, then changed email in-app, could still be signed back in by
  // the ORIGINAL Google account afterward. A successful verify must always
  // disconnect any linked OAuth account and revoke other sessions.
  it("disconnects any linked Google/OAuth account and revokes other sessions on success", async () => {
    identityChangeState.disconnectedProviders = ["google"];
    const result = await verifyStudentEmailChange({
      studentAuthUserId: AUTH_USER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: true });
    expect(disconnectOAuthAccounts).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(revokeOtherSessionsBestEffort).toHaveBeenCalledTimes(1);
    expect(state.sentEmails[0].body).toContain("Google");
  });

  it("reports googleDisconnected: false when no OAuth account was linked", async () => {
    identityChangeState.disconnectedProviders = [];
    const result = await verifyStudentEmailChange({
      studentAuthUserId: AUTH_USER_ID,
      newEmail: "new@example.com",
      otp: "123456",
    });
    expect(result).toEqual({ ok: true, googleDisconnected: false });
    expect(state.sentEmails[0].body).not.toContain("Google");
  });
});

describe("syncStudentEmailFromAuth", () => {
  it("no-ops when auth and row emails already agree (case-insensitive)", async () => {
    const moved = await syncStudentEmailFromAuth({ id: AUTH_USER_ID, email: "OLD@example.com" });
    expect(moved).toBe(false);
    expect(state.contactChanges).toHaveLength(0);
    expect(state.sentEmails).toHaveLength(0);
  });

  it("moves every row carrying the old address, audits each, and notifies the old inbox", async () => {
    const moved = await syncStudentEmailFromAuth({ id: AUTH_USER_ID, email: "new@example.com" });
    expect(moved).toBe(true);

    expect(student(STUDENT_ID).email).toBe("new@example.com");
    expect(student(SIBLING_ID).email).toBe("new@example.com"); // same inbox, other teacher
    expect(student(OTHER_ID).email).toBe("lucia@example.com"); // untouched

    expect(state.contactChanges).toHaveLength(2);
    for (const change of state.contactChanges) {
      expect(change).toMatchObject({
        actorType: "student",
        actorAdminId: null,
        beforeJson: { email: "old@example.com" },
        afterJson: { email: "new@example.com" },
      });
    }

    expect(state.sentEmails).toHaveLength(1);
    expect(state.sentEmails[0].to).toBe("old@example.com");
    expect(state.sentEmails[0].body).toContain("new@example.com");

    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "student_contact_updated",
        distinctId: STUDENT_ID,
        properties: expect.objectContaining({ actorType: "student", fields: ["email"] }),
      }),
    );
  });

  it("updates only the linked row when it had no email, and skips the notice", async () => {
    student(STUDENT_ID).email = null;
    const moved = await syncStudentEmailFromAuth({ id: AUTH_USER_ID, email: "new@example.com" });
    expect(moved).toBe(true);
    expect(student(STUDENT_ID).email).toBe("new@example.com");
    expect(student(SIBLING_ID).email).toBe("old@example.com");
    expect(state.sentEmails).toHaveLength(0);
  });

  it("a notice failure is best-effort — rows stay moved and nothing throws", async () => {
    state.emailSendOk = false;
    const moved = await syncStudentEmailFromAuth({ id: AUTH_USER_ID, email: "new@example.com" });
    expect(moved).toBe(true);
    expect(student(STUDENT_ID).email).toBe("new@example.com");
  });

  it("returns false for auth users with no linked row", async () => {
    const moved = await syncStudentEmailFromAuth({
      id: "99999999-9999-4999-8999-999999999999",
      email: "new@example.com",
    });
    expect(moved).toBe(false);
  });
});

describe("adminSetStudentEmail", () => {
  it("moves auth first, then the rows, audits with the admin id, and notifies both inboxes", async () => {
    const result = await adminSetStudentEmail({
      studentId: STUDENT_ID,
      newEmail: "New@Example.com",
      actorAdminId: ADMIN_ID,
    });
    expect(result).toEqual({ ok: true, changed: true });

    expect(state.updateUserByIdCalls).toHaveLength(1);
    expect(state.updateUserByIdCalls[0]).toEqual({
      id: AUTH_USER_ID,
      attrs: { email: "new@example.com", emailVerified: true },
    });

    expect(student(STUDENT_ID).email).toBe("new@example.com");
    expect(student(SIBLING_ID).email).toBe("new@example.com");
    expect(state.contactChanges).toHaveLength(2);
    expect(state.contactChanges[0]).toMatchObject({
      actorType: "admin",
      actorAdminId: ADMIN_ID,
    });

    const recipients = state.sentEmails.map((e) => e.to).sort();
    expect(recipients).toEqual(["new@example.com", "old@example.com"]);

    // Admin-driven change: same Google/OAuth-disconnect security step as
    // self-service, but sessions are revoked by user id (revokeAllSessionsForUser)
    // rather than "other than current" — the current session here is the
    // ADMIN's, not the student's (see lib/auth/identity-change.ts).
    expect(disconnectOAuthAccounts).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(revokeOtherSessionsBestEffort).not.toHaveBeenCalled();
  });

  it("refuses an address already used by another student on the same roster", async () => {
    const result = await adminSetStudentEmail({
      studentId: STUDENT_ID,
      newEmail: "lucia@example.com",
      actorAdminId: ADMIN_ID,
    });
    expect(result).toEqual({ ok: false, error: "email-taken" });
    expect(state.updateUserByIdCalls).toHaveLength(0);
    expect(student(STUDENT_ID).email).toBe("old@example.com");
  });

  it("propagates an auth failure without touching the rows", async () => {
    state.updateUserByIdError = { status: 422 };
    const result = await adminSetStudentEmail({
      studentId: STUDENT_ID,
      newEmail: "new@example.com",
      actorAdminId: ADMIN_ID,
    });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(student(STUDENT_ID).email).toBe("old@example.com");
    expect(state.contactChanges).toHaveLength(0);
    // The auth update never succeeded — nothing downstream should run.
    expect(disconnectOAuthAccounts).not.toHaveBeenCalled();
  });

  it("updates an unlinked student's row directly: no auth call, no notices, NULL bootstrap admin", async () => {
    const result = await adminSetStudentEmail({
      studentId: SIBLING_ID,
      newEmail: "fixed@example.com",
      actorAdminId: null,
    });
    expect(result).toEqual({ ok: true, changed: true });
    expect(state.updateUserByIdCalls).toHaveLength(0);
    expect(state.sentEmails).toHaveLength(0);
    // Rows sharing the old inbox move together here too.
    expect(student(SIBLING_ID).email).toBe("fixed@example.com");
    expect(student(STUDENT_ID).email).toBe("fixed@example.com");
    expect(state.contactChanges.every((c) => c.actorAdminId === null)).toBe(true);
    expect(state.contactChanges.every((c) => c.actorType === "admin")).toBe(true);
    // No auth identity on an unlinked student — nothing to disconnect/revoke.
    expect(disconnectOAuthAccounts).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it("re-submitting the current address is a no-op", async () => {
    const result = await adminSetStudentEmail({
      studentId: STUDENT_ID,
      newEmail: "OLD@example.com",
      actorAdminId: ADMIN_ID,
    });
    expect(result).toEqual({ ok: true, changed: false });
    expect(state.updateUserByIdCalls).toHaveLength(0);
    expect(state.contactChanges).toHaveLength(0);
  });
});
