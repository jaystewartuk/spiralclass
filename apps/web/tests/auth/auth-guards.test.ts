import { beforeEach, describe, expect, it, vi } from "vitest";

// The rest of src/lib/auth.ts's exports (requireTeacher's lazy-provisioning
// is separately pinned in require-teacher.test.ts). These guards are used on
// nearly every teacher/student page and route handler — almost always via a
// module-level vi.mock("@/lib/auth") that stubs the whole file out, which
// means their own branches have never actually run under test:
//   * getAuthUser / requireAuthUser: session -> user, or redirect to sign-in
//   * getCurrentTeacher / getCurrentStudent: null-safe lookups for an
//     unauthenticated caller (no user -> no query at all)
//   * requireStudent: the mirror of requireTeacher's mutual-exclusivity
//     guard — a user with no linked Student row is bounced home instead of
//     being handed someone else's data or a crash
//   * requireOnboardedTeacher: gates on onboardingCompleteAt
//
// React cache() is neutralised to identity so each call re-runs against the
// current mocks instead of the first call's memoized result.
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const getSession = vi.fn();
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { getSession } },
}));

const teacherFindUnique = vi.fn();
const teacherCreate = vi.fn();
const studentFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: teacherFindUnique, create: teacherCreate },
    student: { findFirst: studentFindFirst },
  },
}));

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
const sentrySetUser = vi.fn();
vi.mock("@sentry/nextjs", () => ({ setUser: sentrySetUser }));
const identifyServerUser = vi.fn();
const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ identifyServerUser, trackServerEvent }));
vi.mock("@/lib/subscriptions/service", () => ({
  ensureSubscriptionForTeacher: vi.fn(async () => {}),
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const {
  getAuthUser,
  requireAuthUser,
  getCurrentTeacher,
  getCurrentStudent,
  requireStudent,
  requireOnboardedTeacher,
} = await import("@/lib/auth");

const USER_ID = "22222222-2222-4222-8222-222222222222";
const USER = { id: USER_ID, email: "user@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAuthUser", () => {
  it("returns the session user when signed in", async () => {
    getSession.mockResolvedValue({ user: USER });

    await expect(getAuthUser()).resolves.toBe(USER);
  });

  it("returns null when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(getAuthUser()).resolves.toBeNull();
  });
});

describe("requireAuthUser", () => {
  it("returns the user when signed in", async () => {
    getSession.mockResolvedValue({ user: USER });

    await expect(requireAuthUser()).resolves.toBe(USER);
  });

  it("redirects to sign-in when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(requireAuthUser()).rejects.toThrow("REDIRECT:/sign-in");
  });
});

describe("getCurrentTeacher", () => {
  it("looks up the teacher row for the signed-in user", async () => {
    getSession.mockResolvedValue({ user: USER });
    const teacher = { id: USER_ID, email: USER.email };
    teacherFindUnique.mockResolvedValue(teacher);

    await expect(getCurrentTeacher()).resolves.toBe(teacher);
    expect(teacherFindUnique).toHaveBeenCalledWith({ where: { id: USER_ID } });
  });

  it("returns null without querying when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(getCurrentTeacher()).resolves.toBeNull();
    expect(teacherFindUnique).not.toHaveBeenCalled();
  });
});

describe("getCurrentStudent", () => {
  it("looks up the student row for the signed-in user", async () => {
    getSession.mockResolvedValue({ user: USER });
    const student = { id: "student-1", authUserId: USER_ID };
    studentFindFirst.mockResolvedValue(student);

    await expect(getCurrentStudent()).resolves.toBe(student);
    expect(studentFindFirst).toHaveBeenCalledWith({ where: { authUserId: USER_ID } });
  });

  it("returns null without querying when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(getCurrentStudent()).resolves.toBeNull();
    expect(studentFindFirst).not.toHaveBeenCalled();
  });
});

describe("requireStudent", () => {
  it("returns the linked student and attaches Sentry/PostHog observability", async () => {
    getSession.mockResolvedValue({ user: USER });
    const student = { id: "student-1", authUserId: USER_ID, email: "kid@example.com" };
    studentFindFirst.mockResolvedValue(student);

    await expect(requireStudent()).resolves.toBe(student);
    expect(sentrySetUser).toHaveBeenCalledWith({ id: student.id, email: student.email });
    expect(identifyServerUser).toHaveBeenCalledWith(student.id, {
      email: student.email,
      role: "student",
    });
  });

  it("bounces home a signed-in user with no linked student row", async () => {
    getSession.mockResolvedValue({ user: USER });
    studentFindFirst.mockResolvedValue(null);

    await expect(requireStudent()).rejects.toThrow("REDIRECT:/");
    expect(sentrySetUser).not.toHaveBeenCalled();
  });

  it("redirects to sign-in before even checking for a student row", async () => {
    getSession.mockResolvedValue(null);

    await expect(requireStudent()).rejects.toThrow("REDIRECT:/sign-in");
    expect(studentFindFirst).not.toHaveBeenCalled();
  });
});

describe("requireOnboardedTeacher", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ user: USER });
    studentFindFirst.mockResolvedValue(null);
  });

  it("returns the teacher once onboarding is complete", async () => {
    const teacher = { id: USER_ID, email: USER.email, onboardingCompleteAt: new Date() };
    teacherFindUnique.mockResolvedValue(teacher);

    await expect(requireOnboardedTeacher()).resolves.toBe(teacher);
  });

  it("redirects to the onboarding flow when it hasn't been completed", async () => {
    teacherFindUnique.mockResolvedValue({
      id: USER_ID,
      email: USER.email,
      onboardingCompleteAt: null,
    });

    await expect(requireOnboardedTeacher()).rejects.toThrow("REDIRECT:/onboarding/timezone");
  });
});
