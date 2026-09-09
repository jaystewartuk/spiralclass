import { describe, expect, it } from "vitest";
import { buildVariables } from "@/lib/notifications/dispatcher";

// Dual-timezone display feature: every CLASS date/time notification must
// show the recipient's own local time (primary) AND the other
// participant's local time (secondary, labeled by name) — see
// packages/shared/src/dual-zone.ts and dispatcher.ts's formatClassDateTime.

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// 16:00 UTC — 10:00 a.m. in Mexico City (UTC-6), 5:00 p.m. in London (BST, UTC+1).
const SCHEDULED_START = new Date("2026-07-15T16:00:00Z");

function fakePrisma(studentTimezone: string | null = "Europe/London") {
  return {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        status: "scheduled",
        packageId: "package-1",
        scheduledStart: SCHEDULED_START,
        scheduledEnd: new Date(SCHEDULED_START.getTime() + 50 * 60 * 1000),
        studentId: "student-1",
        student: { name: "Jay Stewart", timezone: studentTimezone },
      }),
    },
    package: {
      findFirst: async () => null,
    },
    teacherStudent: {
      findUnique: async () => ({ archivedAt: null }),
    },
  } as never;
}

const notification = {
  id: "n1",
  teacherId: TEACHER_ID,
  bookingId: BOOKING_ID,
  paymentId: null,
  metadata: null,
};

describe("student-recipient class-time templates show the teacher's time as secondary", () => {
  it("booking_confirmation appends the teacher's local time, labeled by name", async () => {
    const result = await buildVariables(fakePrisma(), {
      templateName: "booking_confirmation",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "Europe/London",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { classDateTime } = result.variables as { classDateTime: string };
    expect(classDateTime).toContain("10:00 AM"); // student's own (viewer) time, primary
    expect(classDateTime).toContain("Alicia Moreno"); // labeled by the teacher's name
    // Teacher's local time, secondary. 5, not 05 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(classDateTime).toContain("5:00 PM");
  });

  it("still shows a secondary segment when both parties share a timezone", async () => {
    const result = await buildVariables(fakePrisma("America/Mexico_City"), {
      templateName: "booking_confirmation",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "America/Mexico_City",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { classDateTime } = result.variables as { classDateTime: string };
    // Per spec: always render both, even when identical.
    expect(classDateTime).toContain("Alicia Moreno:");
  });
});

describe("teacher-recipient class-time templates show the student's time as secondary", () => {
  it("reminder_24h_teacher appends the specific booking's student local time", async () => {
    const result = await buildVariables(fakePrisma("Europe/London"), {
      templateName: "reminder_24h_teacher",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "America/Mexico_City",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { classDateTime } = result.variables as { classDateTime: string };
    expect(classDateTime).toContain("10:00 AM"); // teacher's own (viewer) time, primary
    expect(classDateTime).toContain("Jay Stewart"); // labeled by the student's name
    // Student's local time, secondary. 5, not 05 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(classDateTime).toContain("5:00 PM");
  });

  it("falls back to the teacher's own zone when the student has none set", async () => {
    const result = await buildVariables(fakePrisma(null), {
      templateName: "reminder_24h_teacher",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "America/Mexico_City",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { classDateTime } = result.variables as { classDateTime: string };
    // No crash, no "undefined" zone — degrades to repeating the teacher's own time.
    expect(classDateTime).not.toContain("undefined");
    expect(classDateTime).toContain("10:00 AM");
  });
});

describe("cancellation and reschedule class-time templates carry both zones", () => {
  it("cancel_gte24h_with_reschedule (student recipient) labels the teacher's time", async () => {
    const result = await buildVariables(fakePrisma("Europe/London"), {
      templateName: "cancel_gte24h_with_reschedule",
      notification,
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "Europe/London",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { originalDateTime } = result.variables as { originalDateTime: string };
    expect(originalDateTime).toContain("10:00 AM");
    expect(originalDateTime).toContain("Alicia Moreno");
    expect(originalDateTime).toContain("5:00 PM");
  });

  it("reschedule_confirm_teacher labels both old and new times with the student's zone", async () => {
    const result = await buildVariables(fakePrisma("Europe/London"), {
      templateName: "reschedule_confirm_teacher",
      notification: { ...notification, metadata: { oldScheduledStart: "2026-07-14T16:00:00Z" } },
      teacherName: "Alicia Moreno",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "en",
      teacherTimezone: "America/Mexico_City",
      storage: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { oldDateTime, newDateTime } = result.variables as {
      oldDateTime: string;
      newDateTime: string;
    };
    expect(oldDateTime).toContain("Jay Stewart");
    expect(newDateTime).toContain("Jay Stewart");
    expect(newDateTime).toContain("5:00 PM");
  });
});
