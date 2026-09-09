import { describe, expect, it } from "vitest";

import {
  buildVcalendar,
  buildVevent,
  escapeIcsText,
  formatIcsUtc,
  type IcsEvent,
} from "@/lib/calendar/ics";
import { buildGoogleCalendarUrl, buildBookingCalendarLinks } from "@/lib/calendar/add-to-calendar";
import { feedTokenRole } from "@/lib/calendar/feed-token";

const start = new Date("2026-06-15T16:00:00.000Z");
const end = new Date("2026-06-15T16:50:00.000Z");

describe("formatIcsUtc", () => {
  it("formats a UTC instant without separators and a trailing Z", () => {
    expect(formatIcsUtc(start)).toBe("20260615T160000Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes commas, semicolons, backslashes and newlines", () => {
    expect(escapeIcsText("a, b; c\\d\ne")).toBe("a\\, b\\; c\\\\d\\ne");
  });
});

describe("buildVevent", () => {
  const event: IcsEvent = {
    uid: "booking-1@spiralclass.com",
    start,
    end,
    summary: "Clase con Mira",
    status: "CONFIRMED",
  };

  it("emits the required properties with CRLF line breaks", () => {
    const out = buildVevent(event, new Date("2026-06-01T00:00:00Z"));
    expect(out).toContain("\r\n");
    expect(out).toMatch(/^BEGIN:VEVENT/);
    expect(out).toMatch(/END:VEVENT$/);
    expect(out).toContain("UID:booking-1@spiralclass.com");
    expect(out).toContain("DTSTART:20260615T160000Z");
    expect(out).toContain("DTEND:20260615T165000Z");
    expect(out).toContain("SUMMARY:Clase con Mira");
    expect(out).toContain("STATUS:CONFIRMED");
    expect(out).toContain("DTSTAMP:20260601T000000Z");
  });
});

describe("buildVcalendar", () => {
  it("wraps events with a valid VCALENDAR envelope and calendar name", () => {
    const ics = buildVcalendar([{ uid: "a@x", start, end, summary: "One" }], {
      name: "Mis clases",
      refresh: "PT12H",
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("X-WR-CALNAME:Mis clases");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
    expect(ics).toContain("BEGIN:VEVENT");
  });

  it("handles an empty calendar", () => {
    const ics = buildVcalendar([]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

describe("buildGoogleCalendarUrl", () => {
  it("encodes the title and UTC date range", () => {
    const url = buildGoogleCalendarUrl({ start, end, title: "Clase con Mira" });
    expect(url).toContain("https://calendar.google.com/calendar/render?");
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("text=Clase+con+Mira");
    expect(url).toContain("dates=20260615T160000Z%2F20260615T165000Z");
  });
});

describe("buildBookingCalendarLinks", () => {
  it("returns both a Google URL and a single-event ics", () => {
    const { googleUrl, ics } = buildBookingCalendarLinks({
      uid: "booking-9@spiralclass.com",
      booking: { start, end, title: "Class with Mira" },
    });
    expect(googleUrl).toContain("calendar.google.com");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:booking-9@spiralclass.com");
    expect(ics).toContain("SUMMARY:Class with Mira");
  });
});

describe("feedTokenRole", () => {
  it("routes by prefix and rejects unknown tokens", () => {
    expect(feedTokenRole("tch_abc123")).toBe("teacher");
    expect(feedTokenRole("stu_abc123")).toBe("student");
    expect(feedTokenRole("nope")).toBeNull();
  });
});
