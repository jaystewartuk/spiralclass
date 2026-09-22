import { beforeEach, describe, expect, it, vi } from "vitest";

// saveTargetLanguageAction (D-72): the language a teacher teaches — the subject
// itself. Public catalog data shown on the booking page, so the action
// revalidates the booking-page settings and the public /b/<slug> page.

const requireTeacher = vi.fn(async () => ({ id: "t1", bookingSlug: "mira" as string | null }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ requireTeacher: () => requireTeacher() }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "en" }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));
const ensureTeacherFocusTags = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/focus-tags", () => ({
  ensureTeacherFocusTags: (...args: unknown[]) => ensureTeacherFocusTags(...args),
}));

const teacherUpdate = vi.fn(async (_args: unknown) => ({ id: "t1" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacher: { update: (args: unknown) => teacherUpdate(args) } },
}));

const { saveTargetLanguageAction } = await import("@/app/actions/profile");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireTeacher.mockResolvedValue({ id: "t1", bookingSlug: "mira" });
});

describe("saveTargetLanguageAction", () => {
  it("saves a supported language code", async () => {
    const result = await saveTargetLanguageAction(undefined, form({ targetLanguage: "fr" }));
    expect(result).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { targetLanguage: "fr" },
    });
  });

  it("clears the language to null on empty input", async () => {
    const result = await saveTargetLanguageAction(undefined, form({ targetLanguage: "" }));
    expect(result).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { targetLanguage: null },
    });
  });

  it("rejects an unknown language code", async () => {
    const result = await saveTargetLanguageAction(undefined, form({ targetLanguage: "zz9" }));
    expect(result?.error).toBeTruthy();
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("revalidates booking-page settings only — not the public page, not account", async () => {
    await saveTargetLanguageAction(undefined, form({ targetLanguage: "fr" }));
    // One call per action (D-174): /b/<slug> is dynamic and refetches on its
    // own, and a second revalidation would cost this form its result.
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/settings/booking-page"]);
  });

  it("revalidates the same single path when the teacher has no slug", async () => {
    // There is no longer a slug-dependent second call to skip: the action
    // revalidates one path either way (D-174).
    requireTeacher.mockResolvedValue({ id: "t1", bookingSlug: null });
    await saveTargetLanguageAction(undefined, form({ targetLanguage: "fr" }));
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/settings/booking-page"]);
  });
});
