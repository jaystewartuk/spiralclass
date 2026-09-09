import { beforeEach, describe, expect, it, vi } from "vitest";

// setLocaleAction persists the manual language preference to a cookie and
// mirrors the *resolved* locale onto the signed-in user's Teacher/Student row so
// server-side dispatch honors it. Pin: invalid value is a no-op, the cookie is
// always set for a valid preference (concrete locale OR the "system" sentinel),
// and the row mirror picks teacher-vs-student correctly.

const cookieStore = { set: vi.fn() };
const requestHeaders = { get: vi.fn(() => "en-US,en;q=0.9") };
vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => requestHeaders,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const state = { user: null as { id: string } | null, teacher: null as { id: string } | null };
const getAuthUser = vi.fn(async () => state.user);
vi.mock("@/lib/auth", () => ({ getAuthUser }));

const teacherUpdate = vi.fn(async () => ({}));
const studentUpdateMany = vi.fn(async () => ({ count: 1 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: vi.fn(async () => state.teacher),
      update: teacherUpdate,
    },
    student: { updateMany: studentUpdateMany },
  },
}));

const { setLocaleAction } = await import("@/app/actions/locale");

function fd(locale?: string): FormData {
  const f = new FormData();
  if (locale !== undefined) f.set("locale", locale);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = null;
  state.teacher = null;
});

describe("setLocaleAction", () => {
  it("ignores an invalid locale value", async () => {
    await setLocaleAction(fd("de"));
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sets the cookie and revalidates for an anonymous user", async () => {
    await setLocaleAction(fd("en"));
    expect(cookieStore.set).toHaveBeenCalledWith(
      expect.any(String),
      "en",
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(getAuthUser).toHaveBeenCalled();
  });

  it("accepts the 'system' sentinel and stores it verbatim in the cookie", async () => {
    await setLocaleAction(fd("system"));
    expect(cookieStore.set).toHaveBeenCalledWith(
      expect.any(String),
      "system",
      expect.objectContaining({ httpOnly: true }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("accepts the French locale", async () => {
    await setLocaleAction(fd("fr"));
    expect(cookieStore.set).toHaveBeenCalledWith(expect.any(String), "fr", expect.any(Object));
  });

  it("mirrors the resolved locale (not 'system') onto the row for a system pref", async () => {
    state.user = { id: "u3" };
    state.teacher = { id: "u3" };
    // Accept-Language is en-US → "system" resolves to "en" for the DB column,
    // which can't hold the sentinel.
    await setLocaleAction(fd("system"));
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "u3" },
      data: { locale: "en", localeChosenAt: expect.any(Date) },
    });
  });

  it("mirrors the choice onto a teacher row", async () => {
    state.user = { id: "u1" };
    state.teacher = { id: "u1" };
    await setLocaleAction(fd("es-MX"));
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { locale: "es-MX", localeChosenAt: expect.any(Date) },
    });
    expect(studentUpdateMany).not.toHaveBeenCalled();
  });

  it("falls back to the student row when the user is not a teacher", async () => {
    state.user = { id: "u2" };
    state.teacher = null;
    await setLocaleAction(fd("en"));
    expect(studentUpdateMany).toHaveBeenCalledWith({
      where: { authUserId: "u2" },
      data: { locale: "en", localeChosenAt: expect.any(Date) },
    });
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  // The picker is the only writer that may claim a choice was made. The mobile
  // device mirror (api/mobile/auth/locale) must not, or it reverts this one —
  // that regression is covered in tests/mobile/locale-route.test.ts.
  it("stamps localeChosenAt so a device mirror cannot overwrite the pick", async () => {
    state.user = { id: "u1" };
    state.teacher = { id: "u1" };
    await setLocaleAction(fd("es-MX"));
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ localeChosenAt: expect.any(Date) }),
      }),
    );
  });
});
