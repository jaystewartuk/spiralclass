import { beforeEach, describe, expect, it, vi } from "vitest";

// Reminder dispatch. maybeEnqueueReminder runs once per due (booking, leg)
// pair from the reminder-scan cron (Phase 2b-ii) and re-reads the booking's live
// state so canceled/rescheduled bookings don't send stale reminders. It also
// fans out timing-matched materials, and dedupes at the row level so a leg
// re-evaluated on every scan tick sends at most once.

const state = {
  bookingStatus: "scheduled" as string | null,
  materialIds: [] as string[],
  // A pre-existing reminder row for the (bookingId, templateName) the
  // dedup guard looks up. null = no duplicate (the normal first-fire path).
  existingReminder: null as { id: string } | null,
};

const notificationFindFirst = vi.fn(async () => state.existingReminder);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async () =>
        state.bookingStatus === null ? null : { status: state.bookingStatus },
      ),
    },
    notification: {
      findFirst: notificationFindFirst,
    },
  },
}));

const enqueueReminder = vi.fn(async () => "notif-1");
const enqueueReminderTeacher = vi.fn(async () => "notif-teacher-1");
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueReminder, enqueueReminderTeacher }));

const enqueueMaterialsForTiming = vi.fn(async () => state.materialIds);
vi.mock("@/lib/notifications/materials", () => ({ enqueueMaterialsForTiming }));

const emitNotificationQueued = vi.fn(async () => {});
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued }));

const { maybeEnqueueReminder, maybeEnqueueFiveDayMaterials } =
  await import("@/lib/notifications/reminders");

const INPUT = {
  bookingId: "b1",
  teacherId: "t1",
  studentId: "s1",
  which: "24h" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.bookingStatus = "scheduled";
  state.materialIds = [];
  state.existingReminder = null;
});

describe("maybeEnqueueReminder", () => {
  it("enqueues the reminder + emits the event for a still-scheduled booking", async () => {
    const res = await maybeEnqueueReminder(INPUT);
    expect(res.sent).toBe(true);
    expect(enqueueReminder).toHaveBeenCalledTimes(1);
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif-1",
      teacherId: "t1",
    });
  });

  it("also enqueues the teacher reminder + emits its event", async () => {
    await maybeEnqueueReminder(INPUT);
    expect(enqueueReminderTeacher).toHaveBeenCalledTimes(1);
    expect(enqueueReminderTeacher).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teacherId: "t1", bookingId: "b1", which: "24h" }),
    );
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif-teacher-1",
      teacherId: "t1",
    });
  });

  it("short-circuits a duplicate (bookingId, leg) so a re-evaluated leg can't double-send", async () => {
    state.existingReminder = { id: "notif-existing" };
    const res = await maybeEnqueueReminder(INPUT);
    expect(res).toEqual({ sent: false, reason: "duplicate:reminder_24h" });
    expect(enqueueReminder).not.toHaveBeenCalled();
    // Both legs already exist (the findFirst mock returns the same row for the
    // teacher lookup too), so neither re-enqueues nor re-emits.
    expect(enqueueReminderTeacher).not.toHaveBeenCalled();
    expect(emitNotificationQueued).not.toHaveBeenCalled();
    // The dedup lookup is keyed on the leg's template + the booking/student.
    expect(notificationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "b1",
          templateName: "reminder_24h",
          recipientId: "s1",
          teacherId: "t1",
        }),
      }),
    );
  });

  it("short-circuits a canceled booking without enqueueing", async () => {
    state.bookingStatus = "canceled";
    const res = await maybeEnqueueReminder(INPUT);
    expect(res).toEqual({ sent: false, reason: "booking-status:canceled" });
    expect(enqueueReminder).not.toHaveBeenCalled();
  });

  it("short-circuits a missing booking", async () => {
    state.bookingStatus = null;
    const res = await maybeEnqueueReminder(INPUT);
    expect(res).toEqual({ sent: false, reason: "booking-status:missing" });
  });

  it("maps the reminder leg to the materials timing and emits per material", async () => {
    state.materialIds = ["m1", "m2"];
    const res = await maybeEnqueueReminder({ ...INPUT, which: "1h" });
    expect(enqueueMaterialsForTiming).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timing: "t_1h", bookingId: "b1" }),
    );
    expect(res.materialIds).toEqual(["m1", "m2"]);
    // one emit for the teacher reminder + one for the student reminder + one
    // per material
    expect(emitNotificationQueued).toHaveBeenCalledTimes(4);
  });

  it("15m leg enqueues reminder_15m and skips materials (no timing slot)", async () => {
    state.materialIds = ["m1"];
    const res = await maybeEnqueueReminder({ ...INPUT, which: "15m" });
    expect(res.sent).toBe(true);
    expect(enqueueReminder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ which: "15m" }),
    );
    // Materials are skipped for the 15m leg — no timing map entry.
    expect(enqueueMaterialsForTiming).not.toHaveBeenCalled();
    expect(res.materialIds).toEqual([]);
  });
});

describe("maybeEnqueueFiveDayMaterials", () => {
  const M_INPUT = { bookingId: "b1", teacherId: "t1", studentId: "s1" };

  it("enqueues t_5d materials and emits one event per material, with no reminder", async () => {
    state.materialIds = ["m1", "m2"];
    const res = await maybeEnqueueFiveDayMaterials(M_INPUT);

    expect(res).toEqual({ sent: true, materialIds: ["m1", "m2"] });
    expect(enqueueMaterialsForTiming).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timing: "t_5d", bookingId: "b1", studentId: "s1" }),
    );
    // The whole point of this path: materials without a five-day reminder on
    // either side.
    expect(enqueueReminder).not.toHaveBeenCalled();
    expect(enqueueReminderTeacher).not.toHaveBeenCalled();
    expect(emitNotificationQueued).toHaveBeenCalledTimes(2);
  });

  it("reports sent:false when the booking has no t_5d materials", async () => {
    state.materialIds = [];
    const res = await maybeEnqueueFiveDayMaterials(M_INPUT);
    expect(res).toEqual({ sent: false, materialIds: [] });
    expect(emitNotificationQueued).not.toHaveBeenCalled();
  });

  it("short-circuits a canceled booking without enqueueing materials", async () => {
    state.bookingStatus = "canceled";
    const res = await maybeEnqueueFiveDayMaterials(M_INPUT);
    expect(res).toEqual({ sent: false, reason: "booking-status:canceled", materialIds: [] });
    expect(enqueueMaterialsForTiming).not.toHaveBeenCalled();
  });

  it("short-circuits a missing booking", async () => {
    state.bookingStatus = null;
    const res = await maybeEnqueueFiveDayMaterials(M_INPUT);
    expect(res).toEqual({ sent: false, reason: "booking-status:missing", materialIds: [] });
  });
});
