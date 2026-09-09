import { beforeEach, describe, expect, it, vi } from "vitest";

// buildCalendarFeed renders the subscribable iCal feed for a teacher or
// student. Pin: locale-driven calendar name, the teacher vs. identity-set
// student query, cancelled bookings emitted as STATUS:CANCELLED, and the
// empty feed for a missing student.

const state = {
  teacher: { locale: "es-MX", timezone: "America/Mexico_City" } as {
    locale: string | null;
    timezone: string;
  } | null,
  student: { id: "s1", email: "a@b.com", locale: "en", timezone: "Europe/London" } as {
    id: string;
    email: string;
    locale: string | null;
    timezone: string | null;
  } | null,
  bookings: [] as Array<Record<string, unknown>>,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: vi.fn(async () => state.teacher) },
    student: { findUnique: vi.fn(async () => state.student) },
    booking: { findMany: vi.fn(async () => state.bookings) },
  },
}));
vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: vi.fn(async () => ["s1", "s2"]),
}));

const { buildCalendarFeed } = await import("@/lib/calendar/feed");

// RFC 5545 folds long content lines (DESCRIPTION included) at 75 octets with
// a "\r\n " continuation — undo that before substring assertions so a fold
// landing mid-phrase doesn't make an otherwise-correct test flaky.
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    scheduledStart: new Date("2026-07-01T15:00:00Z"),
    scheduledEnd: new Date("2026-07-01T16:00:00Z"),
    status: "scheduled",
    student: { name: "Mira", timezone: "Europe/London" },
    teacher: { name: "Prof", timezone: "America/Mexico_City" },
    ...over,
  };
}

beforeEach(() => {
  state.teacher = { locale: "es-MX", timezone: "America/Mexico_City" };
  state.student = { id: "s1", email: "a@b.com", locale: "en", timezone: "Europe/London" };
  state.bookings = [];
});

describe("buildCalendarFeed — teacher", () => {
  it("uses the Spanish calendar name and emits a VEVENT per booking", async () => {
    state.bookings = [booking()];
    const { ics, calName } = await buildCalendarFeed(
      { kind: "teacher", id: "t1" },
      { appUrl: "https://spiralclass.com/" },
    );
    expect(calName).toBe("Mis clases — SpiralClass");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("Clase: Mira");
    expect(ics).toContain("booking-bk1@spiralclass.com");
    // Dual-timezone display: the teacher-viewer's ICS description carries
    // the student's local time as supplementary text (ICS itself can't show
    // two zones natively — the DTSTART/DTEND auto-localise to the
    // subscriber's own device).
    expect(unfold(ics)).toContain("Hora de Mira");
  });

  it("marks a canceled booking as STATUS:CANCELLED", async () => {
    state.bookings = [booking({ status: "canceled_by_teacher" })];
    const { ics } = await buildCalendarFeed(
      { kind: "teacher", id: "t1" },
      { appUrl: "https://spiralclass.com" },
    );
    expect(ics).toContain("STATUS:CANCELLED");
  });
});

describe("buildCalendarFeed — student", () => {
  it("uses the English name for an en-locale student and lists the teacher", async () => {
    state.bookings = [booking()];
    const { ics, calName } = await buildCalendarFeed(
      { kind: "student", id: "s1" },
      { appUrl: "https://spiralclass.com" },
    );
    expect(calName).toBe("My classes — SpiralClass");
    expect(ics).toContain("Class with Prof");
    // Dual-timezone display: the student-viewer's ICS description carries
    // the teacher's local time as supplementary text.
    expect(unfold(ics)).toContain("Prof's time");
  });

  it("returns an empty calendar for a missing student", async () => {
    state.student = null;
    const { ics } = await buildCalendarFeed(
      { kind: "student", id: "gone" },
      { appUrl: "https://spiralclass.com" },
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
