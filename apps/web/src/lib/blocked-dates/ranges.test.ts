import { describe, expect, it } from "vitest";
import {
  countOverlapping,
  coversDay,
  dayCounts,
  isFullyCovered,
  normalizeRange,
  rangeCovering,
  rangeLength,
  rangesOverlap,
} from "./ranges";

describe("normalizeRange", () => {
  it("orders a backwards pick", () => {
    expect(normalizeRange("2026-09-20", "2026-09-14")).toEqual({
      start: "2026-09-14",
      end: "2026-09-20",
    });
  });

  it("leaves a single day as a one-day range", () => {
    expect(normalizeRange("2026-09-14", "2026-09-14")).toEqual({
      start: "2026-09-14",
      end: "2026-09-14",
    });
  });
});

describe("coversDay", () => {
  const range = { start: "2026-09-14", end: "2026-09-18" };

  it("includes both ends", () => {
    expect(coversDay(range, "2026-09-14")).toBe(true);
    expect(coversDay(range, "2026-09-18")).toBe(true);
  });

  it("excludes the days either side", () => {
    expect(coversDay(range, "2026-09-13")).toBe(false);
    expect(coversDay(range, "2026-09-19")).toBe(false);
  });

  it("compares chronologically across a month boundary", () => {
    // The whole file leans on YMD string order being date order — a range that
    // crosses into a lower-numbered month is where a naive comparison breaks.
    expect(coversDay({ start: "2026-12-28", end: "2027-01-03" }, "2027-01-01")).toBe(true);
    expect(coversDay({ start: "2026-12-28", end: "2027-01-03" }, "2026-12-27")).toBe(false);
  });
});

describe("rangesOverlap", () => {
  it("is true when they touch at one day", () => {
    expect(
      rangesOverlap(
        { start: "2026-09-01", end: "2026-09-05" },
        { start: "2026-09-05", end: "2026-09-09" },
      ),
    ).toBe(true);
  });

  it("is false when they are adjacent but disjoint", () => {
    expect(
      rangesOverlap(
        { start: "2026-09-01", end: "2026-09-04" },
        { start: "2026-09-05", end: "2026-09-09" },
      ),
    ).toBe(false);
  });

  it("is true when one contains the other", () => {
    expect(
      rangesOverlap(
        { start: "2026-09-01", end: "2026-09-30" },
        { start: "2026-09-10", end: "2026-09-11" },
      ),
    ).toBe(true);
  });
});

describe("rangeLength", () => {
  it("counts a single day as one", () => {
    expect(rangeLength({ start: "2026-09-14", end: "2026-09-14" })).toBe(1);
  });

  it("counts both ends", () => {
    expect(rangeLength({ start: "2026-09-14", end: "2026-09-18" })).toBe(5);
  });

  it("counts across a DST transition", () => {
    // Europe/London springs forward on 2026-03-29. Pinned to noon UTC, the
    // subtraction is still a whole number of days; from midnight it would not
    // be, and the round would land a day short over a long enough range.
    expect(rangeLength({ start: "2026-03-28", end: "2026-03-31" })).toBe(4);
  });

  it("counts across a leap day", () => {
    expect(rangeLength({ start: "2028-02-27", end: "2028-03-01" })).toBe(4);
  });

  it("counts across a year boundary", () => {
    expect(rangeLength({ start: "2026-12-30", end: "2027-01-02" })).toBe(4);
  });
});

describe("rangeCovering", () => {
  const blocks = [
    { id: "a", start: "2026-09-01", end: "2026-09-03" },
    { id: "b", start: "2026-09-10", end: "2026-09-12" },
  ];

  it("returns the block a day belongs to", () => {
    expect(rangeCovering(blocks, "2026-09-11")?.id).toBe("b");
  });

  it("returns undefined for a free day", () => {
    expect(rangeCovering(blocks, "2026-09-05")).toBeUndefined();
  });
});

describe("countOverlapping", () => {
  const classes = [
    { start: "2026-09-14", end: "2026-09-14" },
    { start: "2026-09-14", end: "2026-09-14" },
    { start: "2026-09-20", end: "2026-09-20" },
  ];

  it("counts every class touching the range", () => {
    expect(countOverlapping(classes, { start: "2026-09-14", end: "2026-09-20" })).toBe(3);
  });

  it("counts none outside it", () => {
    expect(countOverlapping(classes, { start: "2026-10-01", end: "2026-10-05" })).toBe(0);
  });

  it("counts a class that runs past midnight once, not once per day", () => {
    // The server cancels by interval overlap, so a 23:50–00:40 class collides
    // with the blocks on both days. It is still ONE class, and the warning the
    // teacher reads before blocking has to say one.
    const overnight = [{ start: "2026-09-14", end: "2026-09-15" }];
    expect(countOverlapping(overnight, { start: "2026-09-14", end: "2026-09-15" })).toBe(1);
  });
});

describe("isFullyCovered", () => {
  it("is true when one block contains the range", () => {
    const blocks = [{ start: "2026-09-01", end: "2026-09-30" }];
    expect(isFullyCovered(blocks, { start: "2026-09-10", end: "2026-09-12" })).toBe(true);
  });

  it("is true when two adjacent blocks cover it between them", () => {
    // The case a single containment query misses, and the reason this is a
    // sweep: neither block covers the range alone.
    const blocks = [
      { start: "2026-09-01", end: "2026-09-05" },
      { start: "2026-09-06", end: "2026-09-10" },
    ];
    expect(isFullyCovered(blocks, { start: "2026-09-03", end: "2026-09-08" })).toBe(true);
  });

  it("is false when a one-day gap is left between two blocks", () => {
    const blocks = [
      { start: "2026-09-01", end: "2026-09-04" },
      { start: "2026-09-06", end: "2026-09-10" },
    ];
    expect(isFullyCovered(blocks, { start: "2026-09-03", end: "2026-09-08" })).toBe(false);
  });

  it("is false when the range starts before every block", () => {
    const blocks = [{ start: "2026-09-05", end: "2026-09-10" }];
    expect(isFullyCovered(blocks, { start: "2026-09-01", end: "2026-09-10" })).toBe(false);
  });

  it("is false when the range ends after every block", () => {
    const blocks = [{ start: "2026-09-01", end: "2026-09-05" }];
    expect(isFullyCovered(blocks, { start: "2026-09-01", end: "2026-09-10" })).toBe(false);
  });

  it("is false against no blocks at all", () => {
    expect(isFullyCovered([], { start: "2026-09-01", end: "2026-09-01" })).toBe(false);
  });

  it("ignores block order", () => {
    const blocks = [
      { start: "2026-09-06", end: "2026-09-10" },
      { start: "2026-09-01", end: "2026-09-05" },
    ];
    expect(isFullyCovered(blocks, { start: "2026-09-02", end: "2026-09-09" })).toBe(true);
  });

  it("is not fooled by a block that is contained in an earlier one", () => {
    // A nested block must not advance the cursor backwards and re-open a gap.
    const blocks = [
      { start: "2026-09-01", end: "2026-09-10" },
      { start: "2026-09-03", end: "2026-09-04" },
    ];
    expect(isFullyCovered(blocks, { start: "2026-09-01", end: "2026-09-10" })).toBe(true);
  });
});

describe("dayCounts", () => {
  it("counts one class on its day", () => {
    expect(dayCounts([{ start: "2026-09-14", end: "2026-09-14" }]).get("2026-09-14")).toBe(1);
  });

  it("marks both days of a class that runs past midnight", () => {
    const counts = dayCounts([{ start: "2026-09-14", end: "2026-09-15" }]);
    expect(counts.get("2026-09-14")).toBe(1);
    expect(counts.get("2026-09-15")).toBe(1);
  });

  it("sums classes that share a day", () => {
    const counts = dayCounts([
      { start: "2026-09-14", end: "2026-09-14" },
      { start: "2026-09-14", end: "2026-09-14" },
    ]);
    expect(counts.get("2026-09-14")).toBe(2);
  });

  it("clamps a range long enough to be a data error", () => {
    // Not a real booking shape. The clamp is what stops a bad row from
    // allocating a decade of map entries inside a render.
    const counts = dayCounts([{ start: "2026-01-01", end: "2036-01-01" }], 7);
    expect(counts.size).toBe(7);
  });

  it("leaves untouched days absent rather than zero", () => {
    expect(dayCounts([{ start: "2026-09-14", end: "2026-09-14" }]).has("2026-09-15")).toBe(false);
  });
});
