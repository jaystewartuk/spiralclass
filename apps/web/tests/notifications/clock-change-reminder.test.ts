import { describe, expect, it, vi } from "vitest";
import { buildVariables } from "@/lib/notifications/dispatcher";
import { enqueueReminder, enqueueReminderTeacher } from "@/lib/notifications/enqueue";
import {
  clockShiftFromMetadata,
  reminderClockShiftMinutes,
} from "@/lib/notifications/clock-change";
import { renderEmail } from "@/lib/email/templates";
import { renderPush } from "@/lib/notifications/push";

// Issue 229: a reminder for a class a clock change moved on the student's clock
// says so — to the student in their language, and to the teacher, naming the
// student. The shift is measured when the reminder rows are written and carried
// in their metadata, so the dispatcher and the inbox render the same sentence.

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// 10:00 London on 25 Oct 2026, the first Sunday after the UK leaves summer time.
const START = new Date("2026-10-25T10:00:00Z");
// 10:00 London the week before, in BST.
const PREVIOUS = new Date("2026-10-18T09:00:00Z");

function shiftDb(opts: { studentTz: string | null; previous?: Date | null; throws?: boolean }) {
  const findFirst = vi.fn(async (args: { where: { id?: unknown } }) => {
    if (opts.throws) throw new Error("db down");
    if (typeof args.where.id === "string") {
      return {
        scheduledStart: START,
        teacher: { timezone: "Europe/London" },
        student: { timezone: opts.studentTz },
      };
    }
    return opts.previous ? { scheduledStart: opts.previous } : null;
  });
  return { db: { booking: { findFirst } } as never, findFirst };
}

const INPUT = { bookingId: BOOKING_ID, teacherId: TEACHER_ID, studentId: "s1" };

describe("reminderClockShiftMinutes", () => {
  it("measures the UK leaving summer time against Mexico City's fixed clock", async () => {
    const { db, findFirst } = shiftDb({ studentTz: "America/Mexico_City", previous: PREVIOUS });
    expect(await reminderClockShiftMinutes(db, INPUT)).toBe(60);
    // The previous class is looked for inside this pairing, before this class,
    // and only among classes that happened or will.
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teacherId: TEACHER_ID,
          studentId: "s1",
          id: { not: BOOKING_ID },
          scheduledStart: { lt: START },
          status: { in: ["scheduled", "completed", "no_show"] },
        }),
        orderBy: { scheduledStart: "desc" },
      }),
    );
  });

  it("is zero with no previous class, with no student zone, and when the lookup fails", async () => {
    expect(
      await reminderClockShiftMinutes(
        shiftDb({ studentTz: "America/Mexico_City", previous: null }).db,
        INPUT,
      ),
    ).toBe(0);
    expect(
      await reminderClockShiftMinutes(shiftDb({ studentTz: null, previous: PREVIOUS }).db, INPUT),
    ).toBe(0);
    expect(
      await reminderClockShiftMinutes(
        shiftDb({ studentTz: "America/Mexico_City", throws: true }).db,
        INPUT,
      ),
    ).toBe(0);
  });
});

describe("reminder rows carry the shift", () => {
  function fakeTx() {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      notification: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "n" };
        }),
      },
    };
    return { tx: tx as never, created };
  }

  it("stores a non-zero shift on both legs, and nothing when nothing moved", async () => {
    const { tx, created } = fakeTx();
    await enqueueReminder(tx, { ...INPUT, which: "24h", clockShiftMinutes: 60 });
    await enqueueReminderTeacher(tx, {
      teacherId: TEACHER_ID,
      bookingId: BOOKING_ID,
      which: "1h",
      clockShiftMinutes: -60,
    });
    await enqueueReminder(tx, { ...INPUT, which: "15m", clockShiftMinutes: 0 });
    expect(created[0].metadata).toEqual({ clockShiftMinutes: 60 });
    expect(created[1].metadata).toEqual({ clockShiftMinutes: -60 });
    expect(created[2]).not.toHaveProperty("metadata");
  });

  it("reads back only a finite number", () => {
    expect(clockShiftFromMetadata({ clockShiftMinutes: 60 })).toBe(60);
    expect(clockShiftFromMetadata(null)).toBe(0);
    expect(clockShiftFromMetadata({ clockShiftMinutes: "60" })).toBe(0);
    expect(clockShiftFromMetadata([1])).toBe(0);
  });
});

function renderDb() {
  return {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        status: "scheduled",
        packageId: "package-1",
        scheduledStart: START,
        scheduledEnd: new Date(START.getTime() + 50 * 60 * 1000),
        studentId: "student-1",
        student: { name: "Jules Martin", timezone: "America/Mexico_City" },
      }),
    },
    package: { findFirst: async () => null },
    teacherStudent: { findUnique: async () => ({ archivedAt: null }) },
  } as never;
}

const notification = (metadata: unknown) => ({
  id: "n1",
  teacherId: TEACHER_ID,
  bookingId: BOOKING_ID,
  paymentId: null,
  metadata: metadata as never,
});

describe("the reminder says so", () => {
  it("tells the student in their own language, in the email and the push", async () => {
    const result = await buildVariables(renderDb(), {
      templateName: "reminder_24h",
      notification: notification({ clockShiftMinutes: 60 }),
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es",
      teacherTimezone: "Europe/London",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = (result.variables as { clockChangeNote?: string }).clockChangeNote;
    expect(note).toBe(
      "Los relojes cambiaron desde tu última clase con Alicia Moreno: la misma hora en su reloj ahora es 1 hora más tarde en el tuyo.",
    );

    const email = renderEmail({
      templateName: "reminder_24h",
      languageCode: "es",
      variables: result.variables as never,
      actionUrl: null,
    });
    expect(email.body).toContain(note);
    expect(email.html).toContain("1 hora más tarde");
    // Beside the class time it qualifies, not under the calendar link.
    expect(email.body.indexOf(note!)).toBeGreaterThan(email.body.indexOf("Alicia Moreno"));

    const push = renderPush("reminder_24h", "es", result.variables as never);
    expect(push.body.split("\n")).toEqual([expect.stringContaining("Alicia Moreno"), note]);
  });

  it("tells the teacher the same move, naming the student", async () => {
    const result = await buildVariables(renderDb(), {
      templateName: "reminder_1h_teacher",
      notification: notification({ clockShiftMinutes: 60 }),
      teacherName: "Alicia Moreno",
      recipientTimezone: "Europe/London",
      recipientLocale: "en",
      teacherTimezone: "Europe/London",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = (result.variables as { clockChangeNote?: string }).clockChangeNote;
    expect(note).toBe(
      "The clocks have changed since Jules Martin's last class: the same time on your clock is now 1 hour later on theirs.",
    );
    const email = renderEmail({
      templateName: "reminder_1h_teacher",
      languageCode: "en",
      variables: result.variables as never,
      actionUrl: null,
    });
    expect(email.body).toContain(note);
    expect(renderPush("reminder_1h_teacher", "en", result.variables as never).body).toContain(note);
  });

  it("adds nothing to a reminder whose class did not move", async () => {
    const result = await buildVariables(renderDb(), {
      templateName: "reminder_15m",
      notification: notification(null),
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "fr",
      teacherTimezone: "Europe/London",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.variables as { clockChangeNote?: string }).clockChangeNote).toBeUndefined();
    expect(renderPush("reminder_15m", "fr", result.variables as never).body).not.toContain("\n");
  });
});
