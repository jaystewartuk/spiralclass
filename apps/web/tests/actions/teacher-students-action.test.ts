import { beforeEach, describe, expect, it, vi } from "vitest";

// Silent onboarding roster actions. createStudentAction stages a student with
// an onboardingHoldAt stamp (notifications suppressed until go-live) and
// redirects to the new card; setStudentLiveAction clears the hold. Pins: the
// soft email-dup guard, the staged-row shape (hold stamp + opt-in false), the
// audit write, and the go-live state machine (not-found / already-live / clear).

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

const state = {
  existingByEmail: null as null | { id: string },
  teacherEmailConflict: null as null | { id: string },
  link: { onboardingHoldAt: new Date("2026-06-01") } as { onboardingHoldAt: Date | null } | null,
};

const studentFindFirst = vi.fn(async () => state.existingByEmail);
const teacherFindFirst = vi.fn(async () => state.teacherEmailConflict);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested data shape
const studentCreate = vi.fn(async (_a: { data: any }) => ({ id: "newstu" }));
const tsFindUnique = vi.fn(async () => state.link);
const tsUpdate = vi.fn(async (_a: Record<string, unknown>) => ({}));
const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    student: { create: studentCreate },
    teacherStudent: { update: tsUpdate },
  }),
);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    student: { findFirst: studentFindFirst },
    teacher: { findFirst: teacherFindFirst },
    teacherStudent: { findUnique: tsFindUnique },
    $transaction,
  },
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", country: "MX" })),
}));

type GateResult = { ok: true } | { ok: false; limit: string; cap?: number };
const gateAddStudent = vi.fn(async (..._: unknown[]): Promise<GateResult> => ({ ok: true }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateAddStudent: (...a: unknown[]) => gateAddStudent(...a),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

const writeOverride = vi.fn(async () => {});
vi.mock("@/lib/audit", () => ({ writeOverride }));

const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { createStudentAction, setStudentLiveAction } =
  await import("@/app/actions/teacher-students");

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  return null;
}

const SID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  gateAddStudent.mockResolvedValue({ ok: true as const });
  state.existingByEmail = null;
  state.teacherEmailConflict = null;
  state.link = { onboardingHoldAt: new Date("2026-06-01") };
});

describe("createStudentAction", () => {
  it("rejects an invalid name without creating", async () => {
    const res = await createStudentAction(undefined, form({ name: "" }));
    expect(res).toHaveProperty("error");
    expect(studentCreate).not.toHaveBeenCalled();
  });

  it("blocks adding past the Free-plan student cap with an upgrade nudge, before the email check", async () => {
    gateAddStudent.mockResolvedValue({ ok: false, limit: "students", cap: 3 });
    const res = await createStudentAction(
      undefined,
      form({ name: "Sofía", email: "sofia@example.com", phone: "" }),
    );
    expect(res).toEqual({ error: "UPGRADE" });
    expect(studentFindFirst).not.toHaveBeenCalled();
    expect(studentCreate).not.toHaveBeenCalled();
  });

  it("blocks an obvious email duplicate for the same teacher", async () => {
    state.existingByEmail = { id: "dup" };
    const res = await createStudentAction(
      undefined,
      form({ name: "Sofía", email: "sofia@example.com", phone: "" }),
    );
    expect(res).toHaveProperty("error");
    expect(studentCreate).not.toHaveBeenCalled();
  });

  it("blocks adding a student whose email belongs to a Teacher account (D-38)", async () => {
    state.teacherEmailConflict = { id: "teacher-x" };
    const res = await createStudentAction(
      undefined,
      form({ name: "Sofía", email: "sofia@example.com", phone: "" }),
    );
    expect(res).toHaveProperty("error");
    expect(studentCreate).not.toHaveBeenCalled();
  });

  it("stages a student with a hold stamp, audits, and redirects", async () => {
    const url = await redirectOf(() =>
      createStudentAction(undefined, form({ name: "Sofía", phone: "" })),
    );
    expect(url).toBe("/dashboard/students/newstu");
    const data = studentCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Sofía" });
    expect(data.teacherStudents.create).toMatchObject({ teacherId: "t1" });
    expect(data.teacherStudents.create.onboardingHoldAt).toBeInstanceOf(Date);
    expect(data.notificationPrefs).toEqual({
      class_reminders: true,
      booking_updates: true,
      messages: true,
      class_materials: false,
      expiry_reminders: false,
    });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_student", teacherId: "t1" }),
    );
  });

  // Bug fix: createStudentAction used to write the raw form input straight to
  // phoneE164 with no call to normalizeE164 at all — a bare national-format
  // number never got a "+<calling code>" prefix, unlike every other contact
  // surface (see lib/students/contact.ts). These pin the fix.
  it("normalizes a bare national-format phone to the teacher's own country by default", async () => {
    await redirectOf(() =>
      createStudentAction(undefined, form({ name: "Sofía", phone: "5512345678" })),
    );
    const data = studentCreate.mock.calls[0][0].data;
    expect(data.phoneE164).toBe("+525512345678");
  });

  it("uses the explicit phoneCountry hint over the teacher's own country", async () => {
    await redirectOf(() =>
      createStudentAction(
        undefined,
        form({ name: "Sofía", phone: "5551234567", phoneCountry: "US" }),
      ),
    );
    const data = studentCreate.mock.calls[0][0].data;
    expect(data.phoneE164).toBe("+15551234567");
  });

  it("stores no phone when the field is left blank", async () => {
    await redirectOf(() => createStudentAction(undefined, form({ name: "Sofía", phone: "" })));
    const data = studentCreate.mock.calls[0][0].data;
    expect(data.phoneE164).toBeNull();
  });
});

describe("setStudentLiveAction", () => {
  it("refuses a student not on the roster", async () => {
    state.link = null;
    const res = await setStudentLiveAction(undefined, form({ studentId: SID }));
    expect(res).toHaveProperty("error");
    expect(tsUpdate).not.toHaveBeenCalled();
  });

  it("refuses a student that is already live", async () => {
    state.link = { onboardingHoldAt: null };
    const res = await setStudentLiveAction(undefined, form({ studentId: SID }));
    expect(res).toHaveProperty("error");
    expect(tsUpdate).not.toHaveBeenCalled();
  });

  it("clears the hold, audits the transition, and returns ok", async () => {
    const res = await setStudentLiveAction(undefined, form({ studentId: SID }));
    expect(res).toMatchObject({ ok: expect.any(String) });
    expect(tsUpdate.mock.calls[0][0]).toMatchObject({
      where: { teacherId_studentId: { teacherId: "t1", studentId: SID } },
      data: { onboardingHoldAt: null },
    });
    expect(writeOverride).toHaveBeenCalledWith(expect.objectContaining({ action: "go_live" }));
  });
});
