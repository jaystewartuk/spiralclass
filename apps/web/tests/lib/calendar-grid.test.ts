import { describe, expect, it } from "vitest";

import {
  buildClassMonthGrid,
  buildMonthGrid,
  buildWeekDays,
  firstOfMonth,
  isValidYmd,
  monthOf,
  monthStr,
  parseMonthParam,
  resolveSelectedDay,
  shiftDay,
  shiftMonth,
  weekStartOf,
  ymdToUtcNoon,
} from "@/lib/calendar-grid";

// Pure calendar-date math for the month view. These are dates, not instants —
// the grid must be deterministic and DST-proof regardless of the runner's TZ.

describe("buildMonthGrid", () => {
  it("returns a 42-cell Monday-start grid", () => {
    const grid = buildMonthGrid(2026, 5); // June 2026
    expect(grid).toHaveLength(42);
    // 1 June 2026 is a Monday, so the grid starts exactly on the 1st.
    expect(grid[0].ymd).toBe("2026-06-01");
    expect(grid[0].inCurrentMonth).toBe(true);
    expect(grid[41].ymd).toBe("2026-07-12");
  });

  it("includes leading spill-over days from the previous month", () => {
    const grid = buildMonthGrid(2026, 0); // January 2026 — 1 Jan is a Thursday
    expect(grid[0].ymd).toBe("2025-12-29"); // the Monday before
    expect(grid[0].inCurrentMonth).toBe(false);
    expect(grid[0].monthStr).toBe("2025-12");
    const firstOfJan = grid.find((g) => g.ymd === "2026-01-01")!;
    expect(firstOfJan.inCurrentMonth).toBe(true);
  });

  it("handles a February with a leap day", () => {
    const grid = buildMonthGrid(2028, 1); // Feb 2028 (leap year)
    const feb29 = grid.find((g) => g.ymd === "2028-02-29");
    expect(feb29?.inCurrentMonth).toBe(true);
  });
});

// The class calendar renders a grid whose last week is dropped when it holds
// nothing but next month — two rows of empty cells between the month and the
// agenda panel beneath it. The booking calendars keep all six rows (a grid that
// changes height as you page months moves the tap target under the finger), so
// the trim is opt-in and this is what guards the difference.
describe("buildMonthGrid trailing-spill trim", () => {
  it("is off by default — the booking calendars still get six rows", () => {
    // June 2026 starts on a Monday and has 30 days, so cells 35–41 are all July.
    expect(buildMonthGrid(2026, 5)).toHaveLength(42);
  });

  it("drops a final week that belongs entirely to the next month", () => {
    const grid = buildClassMonthGrid(2026, 5); // June 2026
    expect(grid).toHaveLength(35);
    expect(grid[34].ymd).toBe("2026-07-05");
  });

  it("keeps six rows when the last week still holds a real date", () => {
    // August 2026 starts on a Saturday: a 5-day leading offset plus 31 days
    // reaches into the sixth week, so nothing may be trimmed.
    const grid = buildClassMonthGrid(2026, 7);
    expect(grid).toHaveLength(42);
    expect(grid.some((g) => g.ymd === "2026-08-31" && g.inCurrentMonth)).toBe(true);
  });

  it("never drops a day of the month it is rendering, in any month of a year", () => {
    for (let month0 = 0; month0 < 12; month0++) {
      const full = buildMonthGrid(2026, month0).filter((g) => g.inCurrentMonth);
      const trimmed = buildClassMonthGrid(2026, month0).filter((g) => g.inCurrentMonth);
      expect(trimmed.map((g) => g.ymd)).toEqual(full.map((g) => g.ymd));
    }
  });

  it("always returns whole weeks", () => {
    for (let month0 = 0; month0 < 12; month0++) {
      expect(buildClassMonthGrid(2026, month0).length % 7).toBe(0);
    }
  });
});

describe("shiftMonth", () => {
  it("wraps across the year boundary in both directions", () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
  });
});

describe("parseMonthParam", () => {
  it("parses a well-formed YYYY-MM", () => {
    expect(parseMonthParam("2026-06")).toEqual({ year: 2026, month0: 5 });
  });

  it("rejects malformed or out-of-range input", () => {
    expect(parseMonthParam(undefined)).toBeNull();
    expect(parseMonthParam("2026-13")).toBeNull();
    expect(parseMonthParam("nope")).toBeNull();
  });
});

describe("monthStr / monthOf / firstOfMonth", () => {
  it("round-trips", () => {
    expect(monthStr(2026, 5)).toBe("2026-06");
    expect(monthOf("2026-06-15")).toEqual({ year: 2026, month0: 5 });
    expect(firstOfMonth(2026, 5)).toBe("2026-06-01");
  });
});

describe("ymdToUtcNoon", () => {
  it("pins to noon UTC so date labels never slip a day", () => {
    expect(ymdToUtcNoon("2026-06-12").toISOString()).toBe("2026-06-12T12:00:00.000Z");
  });
});

describe("isValidYmd", () => {
  it("accepts a real calendar date", () => {
    expect(isValidYmd("2026-06-12")).toBe(true);
    expect(isValidYmd("2024-02-29")).toBe(true); // leap day
  });
  it("rejects format-valid but calendar-impossible dates", () => {
    expect(isValidYmd("2026-13-45")).toBe(false); // no month 13
    expect(isValidYmd("2026-02-30")).toBe(false); // rolls to March
    expect(isValidYmd("2026-00-10")).toBe(false); // no month 0
    expect(isValidYmd("2025-02-29")).toBe(false); // not a leap year
  });
  it("rejects malformed strings", () => {
    expect(isValidYmd("2026-6-1")).toBe(false);
    expect(isValidYmd("not-a-date")).toBe(false);
    expect(isValidYmd("2026-06-12T00:00:00Z")).toBe(false);
    expect(isValidYmd("")).toBe(false);
  });
});

describe("weekStartOf", () => {
  it("returns the Monday of a Monday", () => {
    expect(weekStartOf("2026-06-01")).toBe("2026-06-01"); // 1 June 2026 is Monday
  });
  it("returns the preceding Monday for a mid-week day", () => {
    expect(weekStartOf("2026-06-28")).toBe("2026-06-22"); // 28 Jun is Sunday → Mon 22 Jun
  });
  it("returns the preceding Monday for a Sunday", () => {
    expect(weekStartOf("2026-06-07")).toBe("2026-06-01"); // 7 Jun is Sunday
  });
});

describe("buildWeekDays", () => {
  it("returns 7 days starting from Monday", () => {
    const days = buildWeekDays("2026-06-28"); // Sunday → week Mon 22–Sun 28
    expect(days).toHaveLength(7);
    expect(days[0].ymd).toBe("2026-06-22");
    expect(days[6].ymd).toBe("2026-06-28");
  });
  it("all days have inCurrentMonth: true", () => {
    const days = buildWeekDays("2026-06-15");
    expect(days.every((d) => d.inCurrentMonth)).toBe(true);
  });
});

describe("shiftDay", () => {
  it("shifts forward by positive delta", () => {
    expect(shiftDay("2026-06-28", 3)).toBe("2026-07-01");
  });
  it("shifts backward by negative delta", () => {
    expect(shiftDay("2026-07-01", -3)).toBe("2026-06-28");
  });
  it("handles month and year boundaries", () => {
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("resolveSelectedDay", () => {
  const grid = buildMonthGrid(2026, 5); // June 2026
  const gridDays = new Set(grid.map((g) => g.ymd));

  it("honours an explicit in-grid request", () => {
    expect(
      resolveSelectedDay({
        requested: "2026-06-20",
        gridDays,
        todayYmd: "2026-06-12",
        year: 2026,
        month0: 5,
      }),
    ).toBe("2026-06-20");
  });

  it("falls back to today when it lands in the rendered month", () => {
    expect(
      resolveSelectedDay({
        requested: undefined,
        gridDays,
        todayYmd: "2026-06-12",
        year: 2026,
        month0: 5,
      }),
    ).toBe("2026-06-12");
  });

  it("falls back to the 1st when today is outside the month", () => {
    expect(
      resolveSelectedDay({
        requested: "2099-01-01", // not in this grid
        gridDays,
        todayYmd: "2027-01-01",
        year: 2026,
        month0: 5,
      }),
    ).toBe("2026-06-01");
  });
});
