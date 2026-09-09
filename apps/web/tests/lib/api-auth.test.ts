import { describe, expect, it, vi, beforeEach } from "vitest";

// The auth gates in `lib/api/auth.ts` — the guard for any route handler that
// takes a plain `Request` rather than reading `next/headers`.
//
// These had no test of their own. They were exercised incidentally by 220
// route tests, and when those were deleted the coverage went
// with them — leaving a Tier 2 auth path (CLAUDE.md) tested by nothing while
// `/api/materials/generate/stream` still gates on it in production. That is the
// gap this file closes, and it is worth reading as a warning: coverage that
// arrives as a side effect of testing something else disappears silently when
// that something else does.
//
// Each assertion is a refusal somebody could remove without breaking a build:
// the moderation kill-switch, the onboarding gate, and the distinction between
// "no session" and "session but not a teacher" — which must stay different
// statuses, because a client retries one and re-authenticates for the other.

const getSession = vi.fn();
vi.mock("@/lib/auth/server", () => ({ auth: { api: { getSession: () => getSession() } } }));

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { teacher: { findUnique: () => findUnique() } } }));

const setUser = vi.fn();
vi.mock("@sentry/nextjs", () => ({ setUser }));

const identifyServerUser = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ identifyServerUser }));

const { ApiAuthError, getApiUser, requireApiUser, requireApiTeacher, requireApiOnboardedTeacher } =
  await import("@/lib/api/auth");

const req = () => new Request("https://x.test/api/teacher/thing");

const SESSION = {
  user: { id: "t1", email: "mira@example.com", name: "Mira", twoFactorEnabled: true },
};
const ONBOARDED = {
  id: "t1",
  email: "mira@example.com",
  disabledAt: null,
  onboardingCompleteAt: new Date("2026-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(SESSION);
  findUnique.mockResolvedValue(ONBOARDED);
});

describe("getApiUser", () => {
  it("maps a resolved session onto the session-user shape", async () => {
    await expect(getApiUser(req())).resolves.toEqual({
      authUserId: "t1",
      email: "mira@example.com",
      name: "Mira",
      twoFactorEnabled: true,
    });
  });

  it("returns null rather than throwing when there is no session", async () => {
    getSession.mockResolvedValue(null);
    await expect(getApiUser(req())).resolves.toBeNull();
  });

  it("normalizes an empty name to null and a missing 2FA flag to false", async () => {
    getSession.mockResolvedValue({ user: { id: "t1", email: "a@b.c", name: "" } });
    const user = await getApiUser(req());
    expect(user).toMatchObject({ name: null, twoFactorEnabled: false });
  });
});

describe("requireApiUser", () => {
  it("refuses a request with no session as 401 no-session", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireApiUser(req())).rejects.toMatchObject({
      status: 401,
      reason: "no-session",
    });
  });

  it("throws an ApiAuthError, which handle() knows how to render", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireApiUser(req())).rejects.toBeInstanceOf(ApiAuthError);
  });
});

describe("requireApiTeacher", () => {
  it("returns the teacher and identifies her to Sentry and PostHog", async () => {
    await expect(requireApiTeacher(req())).resolves.toBe(ONBOARDED);
    expect(setUser).toHaveBeenCalledWith({ id: "t1", email: "mira@example.com" });
    expect(identifyServerUser).toHaveBeenCalledWith("t1", {
      email: "mira@example.com",
      role: "teacher",
    });
  });

  it("refuses an authenticated user with no teacher row as 403, NOT 401", async () => {
    // The distinction is the point: 401 means "sign in", 403 means "you are
    // signed in and this is not yours". Collapsing them sends a signed-in
    // student round the sign-in loop forever.
    findUnique.mockResolvedValue(null);
    await expect(requireApiTeacher(req())).rejects.toMatchObject({
      status: 403,
      reason: "no-teacher-row",
    });
  });

  it("refuses a moderated teacher — the kill-switch has to hold here too", async () => {
    // Without this, disabling a teacher in /admin does nothing to any route
    // handler she calls; she keeps full access until her session expires.
    findUnique.mockResolvedValue({ ...ONBOARDED, disabledAt: new Date() });
    await expect(requireApiTeacher(req())).rejects.toMatchObject({
      status: 403,
      reason: "teacher-disabled",
    });
  });

  it("identifies nobody when it refuses", async () => {
    findUnique.mockResolvedValue({ ...ONBOARDED, disabledAt: new Date() });
    await expect(requireApiTeacher(req())).rejects.toThrow();
    expect(setUser).not.toHaveBeenCalled();
    expect(identifyServerUser).not.toHaveBeenCalled();
  });

  it("never lazy-creates a teacher row, unlike the page-route guard", async () => {
    // lib/auth.ts's requireTeacher() provisions on first sight. This one must
    // not: a route handler is not a signup flow, and creating a tenant as a
    // side effect of an API call is how a stray request mints a teacher.
    findUnique.mockResolvedValue(null);
    await expect(requireApiTeacher(req())).rejects.toThrow();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("requireApiOnboardedTeacher", () => {
  it("passes an onboarded teacher straight through", async () => {
    await expect(requireApiOnboardedTeacher(req())).resolves.toBe(ONBOARDED);
  });

  it("refuses a teacher who has not finished onboarding as 409", async () => {
    // 409 rather than 403: the caller is legitimate and the state is fixable,
    // which is what tells a client to send her to onboarding instead of
    // showing her a permissions error.
    findUnique.mockResolvedValue({ ...ONBOARDED, onboardingCompleteAt: null });
    await expect(requireApiOnboardedTeacher(req())).rejects.toMatchObject({
      status: 409,
      reason: "onboarding-incomplete",
    });
  });

  it("still applies the disabled check ahead of the onboarding one", async () => {
    // A disabled teacher who never onboarded must read as disabled, not as a
    // fixable onboarding state that invites her back through the flow.
    findUnique.mockResolvedValue({
      ...ONBOARDED,
      disabledAt: new Date(),
      onboardingCompleteAt: null,
    });
    await expect(requireApiOnboardedTeacher(req())).rejects.toMatchObject({
      reason: "teacher-disabled",
    });
  });
});

describe("ApiAuthError", () => {
  it("carries extra fields through for the body handle() builds", async () => {
    const err = new ApiAuthError(429, "rate-limited", { retryAfterMs: 5000 });
    expect(err.status).toBe(429);
    expect(err.reason).toBe("rate-limited");
    expect(err.extra).toEqual({ retryAfterMs: 5000 });
    expect(err.message).toBe("rate-limited");
  });
});
