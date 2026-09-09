import { describe, expect, it } from "vitest";
import { renderPush } from "@/lib/notifications/push";
import { buildVariables } from "@/lib/notifications/dispatcher";

// Unit tests for the push deep-link on cancellation notifications.
// The canceled booking is no longer a valid destination; the push notification
// deep-links to r/re/<bookingId>. Mobile's routeForDeepLink maps that prefix
// to the student book tab so the student can pick a new slot from their
// restored credit — the same destination as the web reschedule flow.

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeBookingPrisma() {
  return {
    booking: {
      findFirst: async () => ({
        id: BOOKING_ID,
        packageId: "pkg-1",
        scheduledStart: new Date("2026-07-01T15:00:00Z"),
        scheduledEnd: new Date("2026-07-01T15:50:00Z"),
        teacherId: TEACHER_ID,
      }),
    },
  } as never;
}

describe("renderPush — cancel templates deep-link to book tab via reschedulePathSuffix", () => {
  it("cancel_lt24h uses reschedulePathSuffix when provided", () => {
    const rendered = renderPush("cancel_lt24h", "es_MX", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
      reschedulePathSuffix: "r/re/booking-id",
    });
    expect(rendered.deepLink).toBe("r/re/booking-id");
  });

  it("cancel_lt24h falls back to null when reschedulePathSuffix is absent", () => {
    const rendered = renderPush("cancel_lt24h", "es_MX", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
    });
    expect(rendered.deepLink).toBeNull();
  });

  it("teacher_cancel uses reschedulePathSuffix as deepLink", () => {
    const rendered = renderPush("teacher_cancel", "es_MX", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
      reschedulePathSuffix: "r/re/booking-id",
    });
    expect(rendered.deepLink).toBe("r/re/booking-id");
  });

  it("cancel_gte24h_with_reschedule uses reschedulePathSuffix as deepLink", () => {
    const rendered = renderPush("cancel_gte24h_with_reschedule", "en", {
      teacherName: "Alicia Moreno",
      originalDateTime: "Tuesday 10:00",
      reschedulePathSuffix: "r/re/booking-id",
    });
    expect(rendered.deepLink).toBe("r/re/booking-id");
  });
});

describe("buildVariables — cancel templates include reschedulePathSuffix for push deep-link", () => {
  it("teacher_cancel includes r/re/<bookingId>", async () => {
    const result = await buildVariables(fakeBookingPrisma(), {
      templateName: "teacher_cancel",
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
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables).toMatchObject({
        reschedulePathSuffix: `r/re/${BOOKING_ID}`,
      });
    }
  });

  it("cancel_lt24h includes r/re/<bookingId>", async () => {
    const result = await buildVariables(fakeBookingPrisma(), {
      templateName: "cancel_lt24h",
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
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.variables as { reschedulePathSuffix?: string }).reschedulePathSuffix).toBe(
        `r/re/${BOOKING_ID}`,
      );
    }
  });

  it("cancel_gte24h_with_reschedule includes r/re/<bookingId>", async () => {
    const result = await buildVariables(fakeBookingPrisma(), {
      templateName: "cancel_gte24h_with_reschedule",
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
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables).toMatchObject({
        reschedulePathSuffix: `r/re/${BOOKING_ID}`,
      });
    }
  });
});
