import { describe, expect, it } from "vitest";

import { classesLeftToTeach } from "@/lib/package-usage";

// The roster shows "classes left to teach": total minus classes already used
// up, but keeping still-upcoming scheduled classes in the "left" bucket so the
// number only drops when a class is actually marked given. These pin that
// arithmetic.
describe("classesLeftToTeach", () => {
  it("counts scheduled classes as still-to-teach (booking doesn't reduce it)", () => {
    // 30-class pack, 23 committed of which 1 is upcoming → 22 taught, 8 left.
    expect(classesLeftToTeach({ classesTotal: 30, classesUsed: 23, scheduled: 1 })).toBe(8);
  });

  it("drops by one when a scheduled class is marked complete", () => {
    // Before: 1 scheduled. classesUsed is unchanged by completion (Model B),
    // scheduled goes 1 → 0, so left-to-teach ticks 8 → 7.
    expect(classesLeftToTeach({ classesTotal: 30, classesUsed: 23, scheduled: 1 })).toBe(8);
    expect(classesLeftToTeach({ classesTotal: 30, classesUsed: 23, scheduled: 0 })).toBe(7);
  });

  it("equals total minus used when nothing is scheduled", () => {
    expect(classesLeftToTeach({ classesTotal: 10, classesUsed: 2, scheduled: 0 })).toBe(8);
  });

  it("clamps to [0, total] against dirty data", () => {
    expect(classesLeftToTeach({ classesTotal: 4, classesUsed: 10, scheduled: 0 })).toBe(0);
    expect(classesLeftToTeach({ classesTotal: 4, classesUsed: 0, scheduled: 9 })).toBe(4);
  });
});
