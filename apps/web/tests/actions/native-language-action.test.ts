import { beforeEach, describe, expect, it, vi } from "vitest";

// saveNativeLanguageAction (D-27): the student's default caption language.

const requireStudent = vi.fn(async () => ({ id: "s1" }));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(),
  requireStudent: () => requireStudent(),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "en" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/validators", () => ({
  studentContactSchema: () => ({ safeParse: () => ({ success: true, data: {} }) }),
  teacherEditStudentContactSchema: () => ({ safeParse: () => ({ success: true, data: {} }) }),
}));
vi.mock("@/lib/students/contact", () => ({ applyStudentContactUpdate: vi.fn() }));
vi.mock("@/lib/students/email-change", () => ({
  requestStudentEmailChange: vi.fn(),
  verifyStudentEmailChange: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ flushAnalytics: vi.fn() }));

const studentUpdate = vi.fn(async (_args: unknown) => ({ id: "s1" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { student: { update: (args: unknown) => studentUpdate(args) } },
}));

const { saveNativeLanguageAction } = await import("@/app/actions/student-contact");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStudent.mockResolvedValue({ id: "s1" });
});

describe("saveNativeLanguageAction", () => {
  it("saves a supported language code", async () => {
    const result = await saveNativeLanguageAction(undefined, form({ nativeLanguage: "pt" }));
    expect(result?.ok).toBeTruthy();
    expect(studentUpdate).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { nativeLanguage: "pt" },
    });
  });

  it("rejects an unsupported language code", async () => {
    const result = await saveNativeLanguageAction(undefined, form({ nativeLanguage: "xx" }));
    expect(result?.error).toBeTruthy();
    expect(studentUpdate).not.toHaveBeenCalled();
  });
});
