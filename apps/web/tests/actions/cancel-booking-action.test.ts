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

beforeEach(() => vi.clearAllMocks());

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
