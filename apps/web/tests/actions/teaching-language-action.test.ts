import { beforeEach, describe, expect, it, vi } from "vitest";

// saveTeachingLanguageAction (D-27): the teacher's default caption language.

const requireTeacher = vi.fn(async () => ({ id: "t1" }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ requireTeacher: () => requireTeacher() }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "en" }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const teacherUpdate = vi.fn(async (_args: unknown) => ({ id: "t1" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacher: { update: (args: unknown) => teacherUpdate(args) } },
}));

const { saveTeachingLanguageAction } = await import("@/app/actions/profile");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireTeacher.mockResolvedValue({ id: "t1" });
});

describe("saveTeachingLanguageAction", () => {
  it("saves a supported language code", async () => {
    const result = await saveTeachingLanguageAction(undefined, form({ teachingLanguage: "fr" }));
    expect(result).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { teachingLanguage: "fr" },
    });
  });

  it("revalidates the booking-page settings (its new home), not account", async () => {
    await saveTeachingLanguageAction(undefined, form({ teachingLanguage: "fr" }));
    expect(revalidatePath).toHaveBeenCalledWith("/settings/booking-page");
    expect(revalidatePath).not.toHaveBeenCalledWith("/settings/account");
  });

  it("rejects an unsupported language code", async () => {
    const result = await saveTeachingLanguageAction(undefined, form({ teachingLanguage: "xx" }));
    expect(result?.error).toBeTruthy();
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("rejects an empty value", async () => {
    const result = await saveTeachingLanguageAction(undefined, form({ teachingLanguage: "" }));
    expect(result?.error).toBeTruthy();
    expect(teacherUpdate).not.toHaveBeenCalled();
  });
});
