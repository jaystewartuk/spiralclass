import { describe, expect, it } from "vitest";

import {
  DAY_END_MINUTES,
  minutesToTime,
  nextRangeDefaults,
  rangesForDay,
  replaceDayRanges,
  timeToMinutes,
  type AvailabilityRange,
} from "./availability-ranges";

describe("timeToMinutes / minutesToTime", () => {
  it("round-trips a time string", () => {
    expect(timeToMinutes("09:30")).toBe(9 * 60 + 30);
    expect(minutesToTime(9 * 60 + 30)).toBe("09:30");
  });

  it("zero-pads hours and minutes", () => {
    expect(minutesToTime(8 * 60)).toBe("08:00");
    expect(minutesToTime(0)).toBe("00:00");
  });

  it("clamps out-of-range minutes to the last minute of the day", () => {
    expect(minutesToTime(24 * 60 + 30)).toBe("23:59");
    expect(minutesToTime(-5)).toBe("00:00");
  });
});

describe("rangesForDay", () => {
  it("returns only the rows for the given weekday, sorted by start time", () => {
    const ranges: AvailabilityRange[] = [
      { weekday: 1, startTime: "15:00", endTime: "18:00" },
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
      { weekday: 1, startTime: "09:00", endTime: "12:00" },
    ];
    expect(rangesForDay(ranges, 1)).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "12:00" },
      { weekday: 1, startTime: "15:00", endTime: "18:00" },
    ]);
  });

  it("returns an empty array when the day has no ranges", () => {
    expect(rangesForDay([], 1)).toEqual([]);
  });
});

describe("replaceDayRanges", () => {
  it("swaps out only the target weekday's rows, leaving other days untouched", () => {
    const ranges: AvailabilityRange[] = [
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
    ];
    const next = replaceDayRanges(ranges, 1, [
      { weekday: 1, startTime: "09:00", endTime: "12:00" },
      { weekday: 1, startTime: "15:00", endTime: "18:00" },
    ]);
    expect(next).toEqual([
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
      { weekday: 1, startTime: "09:00", endTime: "12:00" },
      { weekday: 1, startTime: "15:00", endTime: "18:00" },
    ]);
  });

  it("clearing a day's ranges (disabling it) drops all its rows", () => {
    const ranges: AvailabilityRange[] = [
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
    ];
    expect(replaceDayRanges(ranges, 1, [])).toEqual([
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
    ]);
  });
});

describe("nextRangeDefaults", () => {
  it("defaults to a mid-morning slot for a day with no ranges yet", () => {
    expect(nextRangeDefaults([])).toEqual({ startTime: "10:00", endTime: "11:00" });
  });

  it("starts the new range right after the day's last range ends", () => {
    const ranges: AvailabilityRange[] = [{ weekday: 1, startTime: "09:00", endTime: "13:00" }];
    expect(nextRangeDefaults(ranges)).toEqual({ startTime: "13:00", endTime: "14:00" });
  });

  it("clamps the new range's end to the last minute of the day", () => {
    const ranges: AvailabilityRange[] = [
      { weekday: 1, startTime: "09:00", endTime: minutesToTime(DAY_END_MINUTES - 30) },
    ];
    expect(nextRangeDefaults(ranges)).toEqual({
      startTime: minutesToTime(DAY_END_MINUTES - 30),
      endTime: "23:59",
    });
  });

  it("returns null when the day is already booked solid to the end", () => {
    const ranges: AvailabilityRange[] = [{ weekday: 1, startTime: "09:00", endTime: "23:59" }];
    expect(nextRangeDefaults(ranges)).toBeNull();
  });
});
