import { beforeEach, describe, expect, it, vi } from "vitest";

// Action shell for setStudentNotificationsAsTeacherAction — the mutation
// core (tenancy + prefs shape) is covered in
// tests/students/notification-toggle.test.ts; this verifies the action:
// reads the form fields, maps a not-found result to a message, and
// revalidates the student's page.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "es-MX") }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const setStudentNotificationsEnabledAsTeacher = vi.fn(async () => state.result);
vi.mock("@/lib/students/notification-toggle", () => ({
  setStudentNotificationsEnabledAsTeacher,
}));

const state = { result: { ok: true } as { ok: boolean; reason?: string } };

const { setStudentNotificationsAsTeacherAction } = await import("@/app/actions/notification-prefs");
const { revalidatePath } = await import("next/cache");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.result = { ok: true };
});

describe("setStudentNotificationsAsTeacherAction", () => {
  it("enables and revalidates the student's page", async () => {
    const res = await setStudentNotificationsAsTeacherAction(
      undefined,
      form({ studentId: "s1", enabled: "true" }),
    );
    expect(res?.ok).toBeTruthy();
    expect(setStudentNotificationsEnabledAsTeacher).toHaveBeenCalledWith({}, "t1", "s1", true);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students/s1");
  });

  it("disables when enabled is absent/false", async () => {
    await setStudentNotificationsAsTeacherAction(undefined, form({ studentId: "s1" }));
    expect(setStudentNotificationsEnabledAsTeacher).toHaveBeenCalledWith({}, "t1", "s1", false);
  });

  it("maps a not-found result to a friendly error", async () => {
    state.result = { ok: false, reason: "not-found" };
    const res = await setStudentNotificationsAsTeacherAction(
      undefined,
      form({ studentId: "off-roster", enabled: "true" }),
    );
    expect(res).toHaveProperty("error");
  });
});
