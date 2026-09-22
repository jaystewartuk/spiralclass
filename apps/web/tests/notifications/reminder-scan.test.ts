import { beforeEach, describe, expect, it, vi } from "vitest";

// Due-scan reminders (Phase 2b-ii). scanDueReminders finds upcoming scheduled
// bookings and fires each leg whose fire-time has come due — replacing the old
// per-booking sleepUntil fan-out. maybeEnqueueReminder is stubbed here (its own
// dedup/live-status behavior is covered in reminders.test.ts); this pins the
// leg-selection timing: which (booking, leg) pairs the scan considers due.
//
// The five-day mark is a special case since the 5-day class reminder was
// removed: no leg fires there for either recipient, but the scan still makes a
// materials-only pass at that offset so `t_5d` class materials still go out.
//
// The scan also picks `nextFireAt` — the earliest leg that will come due inside
// the lookahead — which is what lets the cron drop to hourly without the 15m
// leg going late (D-115): scanAndScheduleNextWake arms one delayed
// `reminder.due` at exactly that moment, and the wake re-enters this same scan.

const maybeEnqueueReminder = vi.fn(
  async (_input: { bookingId: string; teacherId: string; studentId: string; which: string }) => ({
    sent: true as boolean,
  }),
);
const maybeEnqueueFiveDayMaterials = vi.fn(
  async (_input: { bookingId: string; teacherId: string; studentId: string }) => ({
    sent: true as boolean,
    materialIds: ["m1"] as string[],
  }),
);
vi.mock("@/lib/notifications/reminders", () => ({
  maybeEnqueueReminder,
  maybeEnqueueFiveDayMaterials,
}));

const { scanDueReminders, scanAndScheduleNextWake, WAKE_LOOKAHEAD_MS, DUE_GRACE_MS } =
  await import("@/lib/notifications/reminder-scan");

const NOW = new Date("2026-07-10T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Row = {
  id: string;
  teacherId: string;
  studentId: string;
  scheduledStart: Date;
  createdAt: Date;
};

function fakePrisma(rows: Row[]) {
  return {
    booking: {
      findMany: vi.fn(async ({ where, take }: { where: any; take: number }) => {
        const { gt, lte } = where.scheduledStart;
        return rows
          .filter((r) => r.scheduledStart > gt && r.scheduledStart <= lte)
          .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())
          .slice(0, take);
      }),
    },
  };
}

const legsFired = () =>
  maybeEnqueueReminder.mock.calls.map((c) => (c[0] as { which: string }).which);

beforeEach(() => vi.clearAllMocks());

describe("scanDueReminders", () => {
  it("fires exactly the legs whose fire-time has passed for an upcoming booking", async () => {
    // Booked 8 days ago (so nothing is guard-skipped), class is 30 min out:
    // the 24h/1h fire-times have passed; the 15m leg fires at start-15m =
    // now+15m, still in the future → not yet due.
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 30 * MIN),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });

    expect(legsFired().sort()).toEqual(["1h", "24h"].sort());
    expect(res).toEqual({
      scanned: 1,
      due: 2,
      sent: 2,
      materialsDue: 1,
      materialsSent: 1,
      // The 15m leg isn't due yet — it's the moment the wake chain arms for.
      nextFireAt: new Date(NOW.getTime() + 15 * MIN),
    });
  });

  it("never fires a five-day class reminder, for the student or the teacher", async () => {
    // The 5-day mark has passed for this booking (class is 30 min out, booked 8
    // days ago), so the old scan would have fired a "5d" leg here. Teachers
    // asked for that reminder to be removed outright — no leg may carry it.
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 30 * MIN),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(legsFired()).not.toContain("5d");
  });

  it("still releases t_5d materials at the five-day mark, with no reminder leg", async () => {
    // Class is 4 days out, booked 8 days ago: the 5-day mark has just passed,
    // and no reminder leg is due yet (24h is still days away). The materials
    // pass must fire on its own.
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 4 * DAY),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });

    expect(maybeEnqueueReminder).not.toHaveBeenCalled();
    expect(maybeEnqueueFiveDayMaterials).toHaveBeenCalledTimes(1);
    expect(maybeEnqueueFiveDayMaterials).toHaveBeenCalledWith({
      bookingId: "b1",
      teacherId: "t1",
      studentId: "s1",
    });
    expect(res).toMatchObject({ due: 0, sent: 0, materialsDue: 1, materialsSent: 1 });
  });

  it("does not back-fire the materials pass for a class booked inside five days", async () => {
    // Class is 3 days out and was booked 2 days ago, so the five-day mark fell
    // a day BEFORE the booking existed. Same guard the reminder legs use: a
    // mark that had already passed at booking time never fires retroactively.
    // (There is no "inside the horizon but before the mark" case to test — the
    // horizon is the mark.)
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 3 * DAY),
        createdAt: new Date(NOW.getTime() - 2 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(maybeEnqueueFiveDayMaterials).not.toHaveBeenCalled();
    expect(res.materialsDue).toBe(0);
  });

  it("never back-fires a leg whose fire-time preceded the booking's creation (tight booking)", async () => {
    // Booked 30 min before start: the 5d-mark/24h/1h fire-times are all before
    // createdAt, so only the 15m leg (start-15m = createdAt+15m) is eligible,
    // and it's due iff its fire-time has passed. Here start is 3 min out, so 15m
    // fired 12 min ago → due; nothing else, the materials pass included.
    const start = new Date(NOW.getTime() + 3 * MIN);
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: start,
        createdAt: new Date(start.getTime() - 30 * MIN),
      },
    ];
    await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(legsFired()).toEqual(["15m"]);
    expect(maybeEnqueueFiveDayMaterials).not.toHaveBeenCalled();
  });

  it("excludes bookings that already started (no leg fires after start)", async () => {
    const rows: Row[] = [
      {
        id: "past",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() - 1 * MIN), // already started
        createdAt: new Date(NOW.getTime() - 3 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(maybeEnqueueReminder).not.toHaveBeenCalled();
    expect(maybeEnqueueFiveDayMaterials).not.toHaveBeenCalled();
    expect(res.scanned).toBe(0);
  });

  it("excludes bookings beyond the 5-day horizon (nothing is due yet)", async () => {
    const rows: Row[] = [
      {
        id: "far",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 10 * DAY),
        createdAt: new Date(NOW.getTime() - 1 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(maybeEnqueueReminder).not.toHaveBeenCalled();
    expect(maybeEnqueueFiveDayMaterials).not.toHaveBeenCalled();
    expect(res.scanned).toBe(0);
  });

  it("counts legs maybeEnqueueReminder reports as already-sent as due-but-not-sent (idempotent re-scan)", async () => {
    maybeEnqueueReminder.mockResolvedValue({ sent: false });
    maybeEnqueueFiveDayMaterials.mockResolvedValue({ sent: false, materialIds: [] });
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 30 * MIN),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    // 30 min out, created long ago → 24h/1h both due (5m still future). The
    // scan re-evaluates every past-due leg each tick; the dedup inside
    // maybeEnqueueReminder makes an already-sent leg a no-op (sent:false), and
    // the materials pass dedupes the same way.
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(res.due).toBe(2);
    expect(res.sent).toBe(0);
    expect(res.materialsDue).toBe(1);
    expect(res.materialsSent).toBe(0);
    expect(legsFired().sort()).toEqual(["1h", "24h"].sort());
  });
});

// ── The wake chain (D-115) ─────────────────────────────────────────────────
//
// The cron is hourly, so the 15m leg can no longer be caught by the grid. Each
// scan instead reports the next moment something comes due, and
// scanAndScheduleNextWake arms a single delayed `reminder.due` there. These
// pin the two halves: which moment the scan picks, and how it gets enqueued.

describe("scanDueReminders — nextFireAt", () => {
  it("picks the earliest leg that comes due inside the lookahead", async () => {
    // Class 80 min out, booked long ago: 24h has passed (fires now), the 1h leg
    // comes due in 20 min and the 15m leg in 65 min. The wake is armed for the
    // nearer of the two — the 15m leg gets its own wake once that one lands.
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 80 * MIN),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(legsFired()).toEqual(["24h"]);
    expect(res.nextFireAt).toEqual(new Date(NOW.getTime() + 20 * MIN));
  });

  it("serves the 15m leg exactly — the wake lands at start-15m, not on a grid tick", async () => {
    // This is the whole point of the chain. The class starts 47 min from now,
    // an offset deliberately unaligned with any cron minute; the 15m leg is due
    // at start-15m = now+32m, which no hourly (or */15) tick would hit.
    const start = new Date(NOW.getTime() + 47 * MIN);
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: start,
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(res.nextFireAt).toEqual(new Date(start.getTime() - 15 * MIN));
  });

  it("returns null when nothing comes due inside the lookahead", async () => {
    // Class 4 days out: the 5-day materials mark has passed (fires now), but the
    // nearest leg (24h) is three days away. No wake — the next hourly tick is
    // soon enough, and an idle day costs one wake an hour and nothing more.
    const rows: Row[] = [
      {
        id: "b1",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 4 * DAY),
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(res.nextFireAt).toBeNull();
  });

  it("ignores a leg exactly at the lookahead edge+1 and takes one exactly on it", async () => {
    // The window is half-open at the near end and closed at the far end:
    // fireTime must satisfy now < fireTime <= now+lookahead.
    const onEdge = new Date(NOW.getTime() + WAKE_LOOKAHEAD_MS + 60 * MIN); // 1h leg lands on the edge
    const past = new Date(NOW.getTime() + WAKE_LOOKAHEAD_MS + 60 * MIN + 1 * MIN);
    const res = await scanDueReminders({
      prisma: fakePrisma([
        {
          id: "edge",
          teacherId: "t1",
          studentId: "s1",
          scheduledStart: onEdge,
          createdAt: new Date(NOW.getTime() - 8 * DAY),
        },
      ]) as never,
      now: NOW,
    });
    expect(res.nextFireAt).toEqual(new Date(NOW.getTime() + WAKE_LOOKAHEAD_MS));

    const beyond = await scanDueReminders({
      prisma: fakePrisma([
        {
          id: "beyond",
          teacherId: "t1",
          studentId: "s1",
          scheduledStart: past,
          createdAt: new Date(NOW.getTime() - 8 * DAY),
        },
      ]) as never,
      now: NOW,
    });
    expect(beyond.nextFireAt).toBeNull();
  });

  it("fires a leg inside the grace window instead of arming a wake for it", async () => {
    // The wake lands against Inngest's clock and is evaluated against this
    // process's; a few seconds of skew must not make the leg "not due yet".
    // If it did, the re-scan would re-arm the same moment, the dedup key would
    // drop it as a duplicate, and the reminder would slip to the next hourly
    // tick. A leg 30s out is therefore due NOW, not a wake candidate.
    const start = new Date(NOW.getTime() + 15 * MIN + 30 * 1000); // 15m leg 30s out
    const res = await scanDueReminders({
      prisma: fakePrisma([
        {
          id: "b1",
          teacherId: "t1",
          studentId: "s1",
          scheduledStart: start,
          createdAt: new Date(NOW.getTime() - 8 * DAY),
        },
      ]) as never,
      now: NOW,
    });
    expect(legsFired()).toContain("15m");
    expect(res.nextFireAt).toBeNull();
  });

  it("still arms a wake for a leg just beyond the grace window", async () => {
    const fireAt = new Date(NOW.getTime() + DUE_GRACE_MS + 1 * MIN);
    const res = await scanDueReminders({
      prisma: fakePrisma([
        {
          id: "b1",
          teacherId: "t1",
          studentId: "s1",
          scheduledStart: new Date(fireAt.getTime() + 15 * MIN), // its 15m leg
          createdAt: new Date(NOW.getTime() - 8 * DAY),
        },
      ]) as never,
      now: NOW,
    });
    expect(legsFired()).not.toContain("15m");
    expect(res.nextFireAt).toEqual(fireAt);
  });

  it("takes the earliest due moment across several bookings", async () => {
    const rows: Row[] = [
      {
        id: "later",
        teacherId: "t1",
        studentId: "s1",
        scheduledStart: new Date(NOW.getTime() + 50 * MIN), // 15m leg at now+35m
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
      {
        id: "sooner",
        teacherId: "t1",
        studentId: "s2",
        scheduledStart: new Date(NOW.getTime() + 22 * MIN), // 15m leg at now+7m
        createdAt: new Date(NOW.getTime() - 8 * DAY),
      },
    ];
    const res = await scanDueReminders({ prisma: fakePrisma(rows) as never, now: NOW });
    expect(res.nextFireAt).toEqual(new Date(NOW.getTime() + 7 * MIN));
  });
});

describe("scanAndScheduleNextWake", () => {
  const upcoming = (startOffsetMs: number): Row[] => [
    {
      id: "b1",
      teacherId: "t1",
      studentId: "s1",
      scheduledStart: new Date(NOW.getTime() + startOffsetMs),
      createdAt: new Date(NOW.getTime() - 8 * DAY),
    },
  ];

  it("arms one delayed reminder.due at the exact next due moment", async () => {
    const enqueue = vi.fn(async () => {});
    const fireAt = new Date(NOW.getTime() + 15 * MIN);

    const res = await scanAndScheduleNextWake({
      prisma: fakePrisma(upcoming(30 * MIN)) as never,
      enqueue,
      now: NOW,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      "reminder.due",
      { scheduledFor: fireAt.toISOString() },
      // startAfter is the absolute moment, not a delay, so a slow scan can't
      // drift the wake later; singletonKey collapses the same moment picked by
      // two overlapping ticks into one wake.
      { startAfter: fireAt, singletonKey: `reminder-wake-${fireAt.toISOString()}` },
    );
    expect(res.wakeScheduledFor).toBe(fireAt.toISOString());
  });

  it("arms nothing when no leg comes due inside the lookahead", async () => {
    const enqueue = vi.fn(async () => {});
    const res = await scanAndScheduleNextWake({
      prisma: fakePrisma(upcoming(4 * DAY)) as never,
      enqueue,
      now: NOW,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(res.wakeScheduledFor).toBeNull();
  });

  it("still fires everything already due before arming the next wake", async () => {
    // A wake is an addition to the scan, never a replacement for it: the same
    // run that arms the 15m leg's wake sends the 24h/1h legs that are due now.
    const enqueue = vi.fn(async () => {});
    await scanAndScheduleNextWake({
      prisma: fakePrisma(upcoming(30 * MIN)) as never,
      enqueue,
      now: NOW,
    });
    expect(legsFired().sort()).toEqual(["1h", "24h"].sort());
  });

  it("carries no booking identity, so a stale wake cannot mis-fire", async () => {
    // The payload is the moment and nothing else. Whatever the wake finds when
    // it lands is re-derived from the live rows — a class cancelled or moved in
    // the interim is simply not due, and the re-scan arms the next moment.
    const enqueue = vi.fn(async () => {});
    await scanAndScheduleNextWake({
      prisma: fakePrisma(upcoming(30 * MIN)) as never,
      enqueue,
      now: NOW,
    });
    const [, data] = enqueue.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.keys(data)).toEqual(["scheduledFor"]);
  });
});

// ── The creation-time scan (on-booking-created.ts, D-115 addendum) ─────────
//
// A wake is only ever armed BY a scan. If scans ran only on the hourly tick or
// on a wake, a booking created between ticks whose next leg fell before the
// next tick had nothing armed for it: the 1h leg slipped to the tick (up to an
// hour late), and a 15m leg for a class starting before the tick never fired
// at all (the tick excludes a booking whose scheduledStart <= now). So
// inngest/functions/on-booking-created.ts re-runs scanAndScheduleNextWake on
// every `booking.created`. These pin what that creation-time run must do: fire
// nothing (the legs already past are before createdAt — the guard — and the
// next one isn't due yet) and arm exactly one wake at that next leg's moment.
describe("scanAndScheduleNextWake — run at booking creation (on-booking-created.ts)", () => {
  // Booked at 10:10, ten minutes past the 10:00 tick; the next tick is 11:00.
  const BOOKED_AT = new Date("2026-07-10T10:10:00Z");
  const at = (hhmm: string) => new Date(`2026-07-10T${hhmm}:00Z`);
  const bookedNow = (start: Date): Row[] => [
    { id: "b1", teacherId: "t1", studentId: "s1", scheduledStart: start, createdAt: BOOKED_AT },
  ];

  it("a scan run at booking creation arms the wake for a leg due before the next hourly tick (15m leg)", async () => {
    // Class at 10:50 — legal for a teacher's self-serve booking, which skips the
    // min-advance window. The 24h and 1h legs fell before createdAt (guarded,
    // never back-fired); the 15m leg is due at 10:35, which the 11:00 tick can
    // never serve — by then scheduledStart <= now and the row is excluded, so
    // without this creation-time run the reminder would NEVER fire.
    const enqueue = vi.fn(async () => {});
    const res = await scanAndScheduleNextWake({
      prisma: fakePrisma(bookedNow(at("10:50"))) as never,
      enqueue,
      now: BOOKED_AT,
    });

    expect(maybeEnqueueReminder).not.toHaveBeenCalled();
    expect(maybeEnqueueFiveDayMaterials).not.toHaveBeenCalled();
    expect(res).toMatchObject({ scanned: 1, due: 0, sent: 0, nextFireAt: at("10:35") });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      "reminder.due",
      { scheduledFor: at("10:35").toISOString() },
      { startAfter: at("10:35"), singletonKey: `reminder-wake-${at("10:35").toISOString()}` },
    );
    expect(res.wakeScheduledFor).toBe(at("10:35").toISOString());
  });

  it("a scan run at booking creation arms the wake for a 1h leg due before the next hourly tick", async () => {
    // Class at 11:30: the 1h leg is due at 10:30. Left to the grid, the 11:00
    // tick would send "one hour before" 30 minutes before class; the
    // creation-time run arms 10:30 instead (the 15m leg at 11:15 is the later
    // candidate and gets its own wake once this one lands and re-scans).
    const enqueue = vi.fn(async () => {});
    const res = await scanAndScheduleNextWake({
      prisma: fakePrisma(bookedNow(at("11:30"))) as never,
      enqueue,
      now: BOOKED_AT,
    });

    expect(maybeEnqueueReminder).not.toHaveBeenCalled();
    expect(res).toMatchObject({ due: 0, sent: 0, nextFireAt: at("10:30") });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      "reminder.due",
      { scheduledFor: at("10:30").toISOString() },
      { startAfter: at("10:30"), singletonKey: `reminder-wake-${at("10:30").toISOString()}` },
    );
  });
});
