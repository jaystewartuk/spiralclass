import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// GET /api/calendar/google/callback — where Google sends the browser back
// after consent. Pins that a valid signed state is not enough on its own: the
// tokens are exchanged and saved only when the browser finishing the consent is
// signed in as the teacher the state names.

const SECRET = "test-session-secret-at-least-16-chars";
const APP_URL = "https://app.test";
const TEACHER = "11111111-1111-1111-1111-111111111111";
const OTHER_TEACHER = "33333333-3333-3333-3333-333333333333";

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL, SESSION_SECRET: SECRET }),
  hasGoogleCalendarCreds: () => true,
}));

type CurrentTeacher = { id: string; disabledAt: Date | null } | null;
const getCurrentTeacherMock = vi.fn(async (): Promise<CurrentTeacher> => null);
vi.mock("@/lib/auth", () => ({ getCurrentTeacher: () => getCurrentTeacherMock() }));

const exchangeCodeForTokensMock = vi.fn(async (_code: string) => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresInSeconds: 3600,
  idToken: null,
}));
vi.mock("@/lib/calendar/google/oauth", async (orig) => ({
  ...(await orig<typeof import("@/lib/calendar/google/oauth")>()),
  exchangeCodeForTokens: (code: string) => exchangeCodeForTokensMock(code),
}));

const saveGoogleConnectionMock = vi.fn(async (_input: { teacherId: string }) => {});
vi.mock("@/lib/calendar/google/connection", () => ({
  saveGoogleConnection: (input: { teacherId: string }) => saveGoogleConnectionMock(input),
}));

const syncTeacherBusyMock = vi.fn(async (_teacherId: string) => {});
vi.mock("@/lib/calendar/google/sync", () => ({
  syncTeacherBusy: (teacherId: string) => syncTeacherBusyMock(teacherId),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { GET } = await import("@/app/api/calendar/google/callback/route");
const { signOAuthState } = await import("@/lib/calendar/google/oauth");
const { signEmailOptOutToken } = await import("@/lib/email/opt-out-token");

function callback(state: string): NextRequest {
  const url = `${APP_URL}/api/calendar/google/callback?code=auth-code&state=${encodeURIComponent(state)}`;
  return new Request(url) as unknown as NextRequest;
}

function landedOn(res: Response): string | null {
  return res.headers.get("location");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Google Calendar consent callback", () => {
  it("connects the calendar of the signed-in teacher who started the consent", async () => {
    getCurrentTeacherMock.mockResolvedValue({ id: TEACHER, disabledAt: null });
    const res = await GET(callback(signOAuthState(TEACHER, SECRET)));

    expect(landedOn(res)).toBe(`${APP_URL}/settings/calendar?google=connected`);
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith("auth-code");
    expect(saveGoogleConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: TEACHER }),
    );
  });

  it("connects nothing when a different teacher is signed in", async () => {
    getCurrentTeacherMock.mockResolvedValue({ id: OTHER_TEACHER, disabledAt: null });
    const res = await GET(callback(signOAuthState(TEACHER, SECRET)));

    expect(landedOn(res)).toBe(`${APP_URL}/settings/calendar?google=error`);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
    expect(saveGoogleConnectionMock).not.toHaveBeenCalled();
  });

  it("connects nothing when nobody is signed in", async () => {
    getCurrentTeacherMock.mockResolvedValue(null);
    const res = await GET(callback(signOAuthState(TEACHER, SECRET)));

    expect(landedOn(res)).toBe(`${APP_URL}/settings/calendar?google=error`);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
    expect(saveGoogleConnectionMock).not.toHaveBeenCalled();
  });

  it("connects nothing for a disabled teacher", async () => {
    getCurrentTeacherMock.mockResolvedValue({ id: TEACHER, disabledAt: new Date() });
    const res = await GET(callback(signOAuthState(TEACHER, SECRET)));

    expect(landedOn(res)).toBe(`${APP_URL}/settings/calendar?google=error`);
    expect(saveGoogleConnectionMock).not.toHaveBeenCalled();
  });

  it("refuses an email opt-out token as the state, even from the teacher it names", async () => {
    getCurrentTeacherMock.mockResolvedValue({ id: TEACHER, disabledAt: null });
    const optOut = signEmailOptOutToken(
      { studentId: "22222222-2222-2222-2222-222222222222", teacherId: TEACHER },
      SECRET,
    );
    const res = await GET(callback(optOut));

    expect(landedOn(res)).toBe(`${APP_URL}/settings/calendar?google=error`);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
    expect(saveGoogleConnectionMock).not.toHaveBeenCalled();
  });
});
