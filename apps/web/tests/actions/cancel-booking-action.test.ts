import { beforeEach, describe, expect, it, vi } from "vitest";

// Cancel actions. The mutations live in handleStudentCancel /
// handleTeacherCancel (covered separately); this verifies the action shells:
// validation, auth, and the outcome→error/ok mapping for both principals.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));
const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: vi.fn(async () => ["s1"]),
}));
vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({ id: "s1" })),
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

// The reader's language, per test. Spanish unless a test says otherwise, which
// is what the suite's cookie (tests/setup.ts) gave every test here before.
const reader = { locale: "es" };
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => reader.locale) }));

const handleStudentCancel = vi.fn();
const handleTeacherCancel = vi.fn();
vi.mock("@/lib/cancellation/cancel-handler", () => ({
  handleStudentCancel,
  handleTeacherCancel,
}));

const { cancelBookingAsStudent, cancelBookingAsTeacher } =
  await import("@/app/actions/cancel-booking");

const BK = "11111111-1111-4111-8111-111111111111";
function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("bookingId", BK);
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  reader.locale = "es";
});

describe("cancelBookingAsStudent", () => {
  it("rejects a non-uuid booking id", async () => {
    const res = await cancelBookingAsStudent(undefined, fd({ bookingId: "x" }));
    expect(res).toHaveProperty("error");
    expect(handleStudentCancel).not.toHaveBeenCalled();
  });

  it.each(["not-found", "wrong-status", "schedule-changes-exhausted"])(
    "maps the %s outcome to an error",
    async (code) => {
      handleStudentCancel.mockResolvedValue({ code });
      expect(await cancelBookingAsStudent(undefined, fd())).toHaveProperty("error");
    },
  );

  it("returns the lt24h-deducted message", async () => {
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      timing: "lt24h",
      bookingId: BK,
      teacherId: "t1",
    });
    const res = await cancelBookingAsStudent(undefined, fd());
    expect(res?.ok).toMatch(/24/);
  });

  it("returns the can-reschedule message for an early cancel", async () => {
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      timing: "gte24h",
      bookingId: BK,
      teacherId: "t1",
    });
    const res = await cancelBookingAsStudent(undefined, fd());
    expect(res?.ok).toBeTruthy();
  });

  it("forwards the optional quick-pick reason to booking_canceled", async () => {
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      timing: "gte24h",
      bookingId: BK,
      teacherId: "t1",
    });
    await cancelBookingAsStudent(undefined, fd({ reason: "schedule_conflict" }));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "booking_canceled",
        properties: expect.objectContaining({ cancellationReason: "schedule_conflict" }),
      }),
    );
  });

  it("omits cancellationReason when no reason was picked", async () => {
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      timing: "gte24h",
      bookingId: BK,
      teacherId: "t1",
    });
    await cancelBookingAsStudent(undefined, fd());
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ cancellationReason: undefined }),
      }),
    );
  });
});

describe("cancelBookingAsTeacher", () => {
  it("requires a reason of at least 3 chars", async () => {
    const res = await cancelBookingAsTeacher(undefined, fd({ reason: "no" }));
    expect(res).toHaveProperty("error");
    expect(handleTeacherCancel).not.toHaveBeenCalled();
  });

  it("maps not-found / wrong-status to errors", async () => {
    handleTeacherCancel.mockResolvedValue({ code: "not-found" });
    expect(await cancelBookingAsTeacher(undefined, fd({ reason: "Estoy enferma" }))).toHaveProperty(
      "error",
    );
  });

  it("confirms the cancel + package restore on success", async () => {
    handleTeacherCancel.mockResolvedValue({
      code: "ok",
      bookingId: BK,
      teacherId: "t1",
    });
    const res = await cancelBookingAsTeacher(undefined, fd({ reason: "Estoy enferma" }));
    expect(res?.ok).toBeTruthy();
  });

  it("forwards the required cancellation reason to booking_canceled", async () => {
    handleTeacherCancel.mockResolvedValue({ code: "ok", bookingId: BK, teacherId: "t1" });
    await cancelBookingAsTeacher(undefined, fd({ reason: "Estoy enferma" }));
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "booking_canceled",
        properties: expect.objectContaining({ cancellationReason: "Estoy enferma" }),
      }),
    );
  });
});

// Every message here was an English/Spanish pair chosen at the call site, so a
// French reader got English for all of them. One was worse: the too-short-reason
// message was a Spanish literal inside the schema, shown to every teacher
// whatever language she read.
describe("cancel messages speak the reader's language", () => {
  it.each([
    ["es", "Da una razón breve."],
    ["en", "Give a brief reason."],
    ["fr", "Indiquez brièvement la raison."],
  ])("asks a %s-reading teacher for a longer reason in her own language", async (locale, copy) => {
    reader.locale = locale;
    const res = await cancelBookingAsTeacher(undefined, fd({ reason: "no" }));
    expect(res?.error).toBe(copy);
  });

  it.each([
    ["es", "Esta clase ya no se puede cancelar desde aquí. Pide a tu profe que la ajuste."],
    ["en", "This class can no longer be canceled from here. Ask your teacher to adjust it."],
    ["fr", "Ce cours ne peut plus être annulé d'ici. Demandez à votre professeur de le modifier."],
  ])("tells a %s-reading student why the class cannot be cancelled", async (locale, copy) => {
    reader.locale = locale;
    handleStudentCancel.mockResolvedValue({ code: "wrong-status" });
    expect((await cancelBookingAsStudent(undefined, fd()))?.error).toBe(copy);
  });

  it("confirms a late cancel and an early one differently, in French", async () => {
    reader.locale = "fr";
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      bookingId: BK,
      teacherId: "t1",
      timing: "lt24h",
    });
    expect((await cancelBookingAsStudent(undefined, fd()))?.ok).toBe(
      "Annulé à moins de 24 h. Le cours est déduit du forfait.",
    );
    handleStudentCancel.mockResolvedValue({
      code: "ok",
      bookingId: BK,
      teacherId: "t1",
      timing: "gte24h",
    });
    expect((await cancelBookingAsStudent(undefined, fd()))?.ok).toBe(
      "Annulé. Vous pouvez reprogrammer votre cours.",
    );
  });
});
