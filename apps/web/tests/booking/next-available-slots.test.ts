import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { findNextAvailableSlots } from "@/lib/booking/next-available-slots";
import type { SlotInputsWire } from "@/lib/booking/slot-inputs";

// Same fixture shape as tests/slots.test.ts: Mon-Fri 09:00-13:00 + 16:00-19:00
// in Mexico City. 2026-04-13 is a Monday.
const TZ = "America/Mexico_City";
const TEACHER = { timezone: TZ, bufferMin: 10, minAdvanceH: 2, maxAdvanceDays: 60 };
const NOW = fromZonedTime("2026-04-13T08:00:00", TZ);

const FULL_AVAILABILITY = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: "09:00", endTime: "13:00", timezone: TZ },
]);

function inputs(overrides: Partial<SlotInputsWire> = {}): SlotInputsWire {
  return {
    availabilityRules: FULL_AVAILABILITY,
    blockedDates: [],
    existingBookings: [],
    ...overrides,
  };
}

describe("findNextAvailableSlots", () => {
  it("finds the very next open day (tomorrow) when it has slots", () => {
    // Anchor Monday 2026-04-13 — Tuesday 2026-04-14 is open.
    const result = findNextAvailableSlots(inputs(), {
      anchorYmd: "2026-04-13",
      horizonDays: 28,
      classDurationMin: 50,
      teacher: TEACHER,
      now: NOW,
    });
    expect(result?.date).toBe("2026-04-14");
    expect(result?.slots.length).toBeGreaterThan(0);
  });

  it("never checks the anchor day itself, even if it has slots", () => {
    // Anchor is itself a bookable Monday, but the search starts at anchor+1.
    const result = findNextAvailableSlots(inputs(), {
      anchorYmd: "2026-04-13",
      horizonDays: 1,
      classDurationMin: 50,
      teacher: TEACHER,
      now: NOW,
    });
    // anchor+1 = Tuesday 04-14, which IS open — proves the loop starts at
    // i=1, not i=0 (the anchor date), by checking it lands one day forward.
    expect(result?.date).toBe("2026-04-14");
  });

  it("skips a weekend with nothing to Monday", () => {
    // Anchor Thursday 04-16: Fri 04-17 is open (skip test), so anchor Friday
    // itself instead — Sat/Sun closed, next open is Monday 04-20.
    const result = findNextAvailableSlots(inputs(), {
      anchorYmd: "2026-04-17", // Friday
      horizonDays: 28,
      classDurationMin: 50,
      teacher: TEACHER,
      now: NOW,
    });
    expect(result?.date).toBe("2026-04-20"); // Monday
  });

  it("returns null when the whole horizon is empty", () => {
    const result = findNextAvailableSlots(inputs({ availabilityRules: [] }), {
      anchorYmd: "2026-04-13",
      horizonDays: 5,
      classDurationMin: 50,
      teacher: TEACHER,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("does not scan past horizonDays", () => {
    // Only Friday 04-17 open within a 1-day horizon of Thursday 04-16 (a
    // non-bookable day this fixture has no rule for — 04-16 is a Thursday,
    // which IS in Mon-Fri, so pick a horizon that stops one day short of the
    // next real opening instead).
    const result = findNextAvailableSlots(inputs(), {
      anchorYmd: "2026-04-17", // Friday
      horizonDays: 2, // covers Sat 04-18, Sun 04-19 — both closed
      classDurationMin: 50,
      teacher: TEACHER,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("applies the filter callback, e.g. excluding a specific slot and honoring an expiry bound", () => {
    const excludedStart = fromZonedTime("2026-04-14T09:00:00", TZ).getTime();
    const cutoff = fromZonedTime("2026-04-14T23:59:59", TZ);
    const result = findNextAvailableSlots(
      inputs(),
      {
        anchorYmd: "2026-04-13",
        horizonDays: 28,
        classDurationMin: 50,
        teacher: TEACHER,
        now: NOW,
      },
      (s) => s.startUtc.getTime() !== excludedStart && s.startUtc <= cutoff,
    );
    // 04-14's 09:00 slot is excluded by name, and everything past 04-14 is
    // excluded by the cutoff — 04-14's OTHER slots (10:00 etc.) still count.
    expect(result?.date).toBe("2026-04-14");
    expect(result?.slots.some((s) => s.startUtc.getTime() === excludedStart)).toBe(false);
  });

  it("returns null when the filter rejects every slot in the whole horizon", () => {
    const result = findNextAvailableSlots(
      inputs(),
      {
        anchorYmd: "2026-04-13",
        horizonDays: 5,
        classDurationMin: 50,
        teacher: TEACHER,
        now: NOW,
      },
      () => false,
    );
    expect(result).toBeNull();
  });
});
