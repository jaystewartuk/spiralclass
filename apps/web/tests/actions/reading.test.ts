import { beforeEach, describe, expect, it, vi } from "vitest";

const setCookie = vi.fn();
const teacherUpdate = vi.fn().mockResolvedValue({ count: 1 });
const studentUpdate = vi.fn().mockResolvedValue({ count: 0 });
const authUser = { value: null as { email: string } | null };

// lib/reading is server-only; the action imports it for its constants.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: setCookie }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser: async () => authUser.value }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { updateMany: (...a: unknown[]) => teacherUpdate(...a) },
    student: { updateMany: (...a: unknown[]) => studentUpdate(...a) },
  },
}));

const { saveReadingPreferences } = await import("@/app/actions/reading");
const { READING_SCALES } = await import("@/lib/reading");

/**
 * Saving reading preferences (D-140).
 *
 * The action writes to two places and the interesting behaviour is entirely in
 * what happens when one of them cannot be written — a reader who has just made
 * the text bigger must not be told her setting failed because a database was
 * briefly unreachable.
 */
describe("saveReadingPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authUser.value = null;
  });

  it("sets the cookie the server reads on the next render", async () => {
    await saveReadingPreferences({ scale: READING_SCALES[1], spacing: 2, tint: true });
    const [name, value, options] = setCookie.mock.calls[0]!;
    expect(name).toBe("reading");
    expect(value).toBe(`${READING_SCALES[1]}|2|1`);
    expect(options).toMatchObject({ path: "/", sameSite: "lax" });
    // A setting, not a session — it has to outlive the browser being closed.
    expect(options.maxAge).toBeGreaterThan(60 * 60 * 24 * 300);
  });

  it("is readable by the client, so the control can show what is selected", () => {
    // Deliberately NOT httpOnly. Noted because the default instinct on a cookie
    // is to lock it down, and here that would break the control.
    expect(setCookie.mock.calls[0]?.[2]?.httpOnly).toBeUndefined();
  });

  it("clamps a scale the UI could never have produced", async () => {
    await saveReadingPreferences({ scale: 9, spacing: 0, tint: false });
    expect(setCookie.mock.calls[0]![1]).toBe("1|0|0");
  });

  it("clamps a spacing step outside the three that exist", async () => {
    await saveReadingPreferences({ scale: 1, spacing: 7 as unknown as 0, tint: false });
    expect(setCookie.mock.calls[0]![1]).toBe("1|0|0");
  });

  it("writes nothing to the database for a signed-out reader", async () => {
    // The public booking page is where a prospective student meets the product.
    // Asking her to sign in before she can make the text bigger would be the
    // wrong way round, so the cookie alone is the whole story there.
    await saveReadingPreferences({ scale: 1, spacing: 1, tint: false });
    expect(setCookie).toHaveBeenCalled();
    expect(teacherUpdate).not.toHaveBeenCalled();
    expect(studentUpdate).not.toHaveBeenCalled();
  });

  it("updates both rows for someone who is a teacher and a student", async () => {
    authUser.value = { email: "mira@example.com" };
    await saveReadingPreferences({ scale: READING_SCALES[2], spacing: 1, tint: true });
    for (const update of [teacherUpdate, studentUpdate]) {
      expect(update).toHaveBeenCalledWith({
        where: { email: "mira@example.com" },
        data: { readingScale: READING_SCALES[2], readingSpacing: 1, readingTint: true },
      });
    }
  });

  it("still succeeds when the database write fails", async () => {
    // The cookie is already set, so the reader gets what she asked for on this
    // device. Losing the cross-device copy is not worth failing the action and
    // showing her an error for a change that visibly worked.
    authUser.value = { email: "mira@example.com" };
    teacherUpdate.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      saveReadingPreferences({ scale: 1, spacing: 0, tint: false }),
    ).resolves.toBeUndefined();
    expect(setCookie).toHaveBeenCalled();
  });
});
