import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// requireTeacher (src/lib/auth.ts) lazy-provisions a teacher row for an
// authenticated user that doesn't have one yet (Supabase-dashboard users, the
// confirm-email signup path). The subtle, security/data-integrity-relevant
// branches this pins:
//   * an existing DISABLED teacher is bounced to "/?error=teacher-disabled"
//   * a user already linked as a STUDENT is sent to the student portal, never
//     given a second (teacher) identity
//   * the concurrent lazy-create RACE: when create() loses to a parallel request
//     (Prisma P2002), requireTeacher adopts the winner's row instead of throwing
//
// React cache() is neutralised to identity so each call re-runs against the
// current mocks (requireTeacher takes no args, so the real per-request memo would
// otherwise pin the first result for the whole test module).
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
// Mutable per-test so the Accept-Language-driven locale stamp (starterLocale)
// can be exercised without a real request — reset to "no header" in beforeEach.
let acceptLanguage: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
}));
vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({
  identifyServerUser: vi.fn(),
  trackServerEvent: vi.fn(),
}));
const ensureSubscriptionForTeacher = vi.fn(async () => {});
vi.mock("@/lib/subscriptions/service", () => ({ ensureSubscriptionForTeacher }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { requireTeacher } = await import("@/lib/auth");

const USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  acceptLanguage = undefined;
  getSession.mockResolvedValue({ user: { id: USER_ID, email: "maestra@example.com" } });
  studentFindFirst.mockResolvedValue(null);
});

describe("requireTeacher", () => {
  it("returns the existing enabled teacher without creating a new row", async () => {
    const existing = { id: USER_ID, email: "maestra@example.com", disabledAt: null };
    teacherFindUnique.mockResolvedValue(existing);

    const teacher = await requireTeacher();

    expect(teacher).toBe(existing);
    expect(teacherCreate).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("bounces a disabled teacher to the disabled-account screen", async () => {
    teacherFindUnique.mockResolvedValue({ id: USER_ID, email: "x@y.com", disabledAt: new Date() });

    await expect(requireTeacher()).rejects.toThrow("REDIRECT:/?error=teacher-disabled");
    expect(teacherCreate).not.toHaveBeenCalled();
  });

  it("sends a user already linked as a student to the student portal with an explanatory notice, not a new teacher row", async () => {
    teacherFindUnique.mockResolvedValue(null);
    studentFindFirst.mockResolvedValue({ id: "student-1", authUserId: USER_ID });

    await expect(requireTeacher()).rejects.toThrow("REDIRECT:/my-classes?notice=already-student");
    expect(teacherCreate).not.toHaveBeenCalled();
  });

  it("lazy-creates a teacher (with starter templates + trial) for a brand-new user", async () => {
    teacherFindUnique.mockResolvedValue(null);
    const created = {
      id: USER_ID,
      email: "maestra@example.com",
      disabledAt: null,
      packageTemplates: [{ id: "tpl-1" }, { id: "tpl-2" }],
    };
    teacherCreate.mockResolvedValue(created);

    const teacher = await requireTeacher();

    expect(teacher).toBe(created);
    expect(teacherCreate).toHaveBeenCalledOnce();
    expect(ensureSubscriptionForTeacher).toHaveBeenCalledWith(USER_ID);
  });

  it("stamps the DEFAULT_LOCALE onto the new row when the request carries no Accept-Language", async () => {
    teacherFindUnique.mockResolvedValue(null);
    teacherCreate.mockResolvedValue({
      id: USER_ID,
      email: "maestra@example.com",
      disabledAt: null,
      packageTemplates: [],
    });

    await requireTeacher();

    expect(teacherCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ locale: "en" }) }),
    );
  });

  // Regression: a signup whose browser sends Spanish must have "es-MX" stamped
  // onto Teacher.locale itself, not just used to seed starter package names.
  // Background jobs with no request context (lesson-insights/brief generation)
  // read this column directly — leaving it at the "en" default silently
  // generated English AI output for a Spanish-reading teacher who never
  // happened to open the language picker.
  it("stamps the Accept-Language-resolved locale onto the new row for a Spanish signup", async () => {
    acceptLanguage = "es-MX,es;q=0.9";
    teacherFindUnique.mockResolvedValue(null);
    teacherCreate.mockResolvedValue({
      id: USER_ID,
      email: "maestra@example.com",
      disabledAt: null,
      packageTemplates: [],
    });

    await requireTeacher();

    expect(teacherCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ locale: "es-MX" }) }),
    );
  });

  it("adopts the winner's row when it loses the concurrent lazy-create race (Prisma P2002)", async () => {
    // First findUnique (pre-create) sees no row; create() throws the unique
    // violation because a parallel request created it first; the recovery
    // findUnique returns the winner's row, which requireTeacher must adopt.
    const winner = { id: USER_ID, email: "maestra@example.com", disabledAt: null };
    teacherFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    teacherCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );

    const teacher = await requireTeacher();

    expect(teacher).toBe(winner);
    expect(redirectMock).not.toHaveBeenCalled();
    // The winner already ran the welcome side effects — the loser must NOT
    // double-provision the subscription.
    expect(ensureSubscriptionForTeacher).not.toHaveBeenCalled();
  });

  it("redirects to the disabled screen if the row it loses the race to is disabled", async () => {
    teacherFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: USER_ID, email: "x@y.com", disabledAt: new Date() });
    teacherCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );

    await expect(requireTeacher()).rejects.toThrow("REDIRECT:/?error=teacher-disabled");
  });

  it("re-throws a non-P2002 create failure instead of masking it", async () => {
    teacherFindUnique.mockResolvedValue(null);
    teacherCreate.mockRejectedValue(new Error("connection reset"));

    await expect(requireTeacher()).rejects.toThrow("connection reset");
  });
});
