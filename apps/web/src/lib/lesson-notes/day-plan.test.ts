import { describe, expect, it } from "vitest";
import {
  DAY_PLAN_PATH,
  dayPlanHref,
  isLastClassOfPackage,
  resolvePlanDay,
} from "@/lib/lesson-notes/day-plan";

const TODAY = "2026-09-24";

describe("resolvePlanDay", () => {
  it("uses a real calendar day from the URL", () => {
    expect(resolvePlanDay("2026-09-30", TODAY)).toBe("2026-09-30");
  });

  it("takes the first value of a repeated parameter", () => {
    expect(resolvePlanDay(["2026-10-01", "2026-10-02"], TODAY)).toBe("2026-10-01");
  });

  it.each([undefined, "", "tomorrow", "2026-9-30", "2026-02-30", "2026-13-01"])(
    "falls back to today for %j rather than failing",
    (raw) => {
      expect(resolvePlanDay(raw, TODAY)).toBe(TODAY);
    },
  );
});

describe("dayPlanHref", () => {
  it("is the bare path for today, so the default view has one URL", () => {
    expect(dayPlanHref(TODAY, TODAY)).toBe(DAY_PLAN_PATH);
  });

  it("carries any other day as ?d=", () => {
    expect(dayPlanHref("2026-09-23", TODAY)).toBe(`${DAY_PLAN_PATH}?d=2026-09-23`);
  });
});

describe("isLastClassOfPackage", () => {
  it("is never true for a class with no package", () => {
    expect(isLastClassOfPackage(null, 0)).toBe(false);
  });

  it("is true when the package is fully committed and nothing is booked after this class", () => {
    expect(isLastClassOfPackage({ classesTotal: 8, classesUsed: 8 }, 0)).toBe(true);
  });

  it("is false while the package still has classes left to book", () => {
    expect(isLastClassOfPackage({ classesTotal: 8, classesUsed: 7 }, 0)).toBe(false);
  });

  it("is false when a later class in the same package is already booked", () => {
    expect(isLastClassOfPackage({ classesTotal: 8, classesUsed: 8 }, 1)).toBe(false);
  });
});
