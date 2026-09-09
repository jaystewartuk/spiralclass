import { describe, expect, it } from "vitest";
import { buildVariables } from "@/lib/notifications/dispatcher";

// Regression: a class canceled (or rescheduled) after its reminder was already
// queued must NOT still send "your class is coming up". The reminder scheduler
// re-checks status at ENQUEUE time, but there's a window between enqueue and
// delivery (and the dispatcher's retry cycle) where a cancel can land — so
// buildVariables re-checks booking.status at SEND time for the "class is on"
// family (reminders, confirmation, materials). The cancel family is exempt: it
// must still render for canceled bookings (covered by cancel-deep-link.test.ts).

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bookingPrismaWithStatus(status: string) {
  return {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        packageId: "pkg-1",
        scheduledStart: new Date("2026-07-06T22:00:00Z"),
        scheduledEnd: new Date("2026-07-06T22:50:00Z"),
        status,
      }),
    },
  } as never;
}

const ctx = (templateName: string) => ({
  templateName: templateName as never,
  notification: {
    id: "n1",
    teacherId: TEACHER_ID,
    bookingId: BOOKING_ID,
    paymentId: null,
    metadata: null,
  },
  teacherName: "Alicia Moreno",
  recipientTimezone: "America/Mexico_City",
  recipientLocale: "es-MX",
  storage: null,
});

describe("reminders skip a booking that is no longer scheduled", () => {
  for (const status of ["canceled_by_teacher", "canceled_by_student", "completed", "no_show"]) {
    it(`reminder_24h → skips for status="${status}"`, async () => {
      const result = await buildVariables(bookingPrismaWithStatus(status), ctx("reminder_24h"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(`booking-not-scheduled:${status}`);
    });
  }

  it("booking_confirmation → skips for a canceled booking", async () => {
    const result = await buildVariables(
      bookingPrismaWithStatus("canceled_by_teacher"),
      ctx("booking_confirmation"),
    );
    expect(result.ok).toBe(false);
  });

  it("reminder_24h → still builds for a scheduled booking", async () => {
    const result = await buildVariables(bookingPrismaWithStatus("scheduled"), ctx("reminder_24h"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.variables as { classDateTime: string }).classDateTime).toBeTruthy();
    }
  });
});
