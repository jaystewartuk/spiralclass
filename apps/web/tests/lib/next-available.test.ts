import { describe, expect, it } from "vitest";
import { addCalendarDays, firstAvailableDay } from "@/lib/booking/next-available";

describe("addCalendarDays", () => {
  it("adds days within a month", () => {
    expect(addCalendarDays("2026-07-05", 3)).toBe("2026-07-08");
  });
  it("rolls across a month boundary", () => {
    expect(addCalendarDays("2026-07-30", 3)).toBe("2026-08-02");
  });
  it("rolls across a year boundary", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("is a no-op for zero", () => {
    expect(addCalendarDays("2026-07-05", 0)).toBe("2026-07-05");
  });
});

describe("firstAvailableDay", () => {
  const window = (open: string[]) => (d: string) => open.includes(d);

  it("returns the starting day when it already has slots", () => {
    expect(firstAvailableDay("2026-07-05", "2026-09-03", window(["2026-07-05"]))).toBe(
      "2026-07-05",
    );
  });

  it("skips forward past empty days to the next open one (Sunday → Monday)", () => {
    // 2026-07-05 is a Sunday with no availability; the teacher opens Monday.
    expect(
      firstAvailableDay("2026-07-05", "2026-09-03", window(["2026-07-06", "2026-07-07"])),
    ).toBe("2026-07-06");
  });

  it("crosses a month boundary to find the next open day", () => {
    expect(firstAvailableDay("2026-07-30", "2026-09-28", window(["2026-08-03"]))).toBe(
      "2026-08-03",
    );
  });

  it("treats the through day as inclusive", () => {
    expect(firstAvailableDay("2026-07-05", "2026-07-10", window(["2026-07-10"]))).toBe(
      "2026-07-10",
    );
  });

  it("returns null when no day in the window has slots", () => {
    expect(firstAvailableDay("2026-07-05", "2026-07-10", () => false)).toBeNull();
  });

  it("does not scan past the through day", () => {
    // The only open day is one past the window — must not be found.
    expect(firstAvailableDay("2026-07-05", "2026-07-09", window(["2026-07-10"]))).toBeNull();
  });
});
