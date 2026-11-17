import { describe, expect, it, vi } from "vitest";
import { CLOCK_CHANGE_LOOKBACK_DAYS, loadTeacherListClockShifts } from "@/lib/clock-change-shifts";

// Issue 229, teacher side: her upcoming list says when a clock change since a
// student's previous class moved that student's class on their clock. The
// previous class is usually not on the page, so it is fetched.

const TEACHER = { id: "t1", timezone: "Europe/London" };
const NOW = new Date("2026-10-20T12:00:00Z");

function db(
  history: Array<{ id: string; studentId: string; scheduledStart: Date; status: string }>,
) {
  const findMany = vi.fn(async () => history);
  return { db: { booking: { findMany } } as never, findMany };
}

describe("loadTeacherListClockShifts", () => {
  it("compares a student's first listed class with the previous one off the page", async () => {
    const { db: fake, findMany } = db([
      // Taught last week, in BST.
      {
        id: "past",
        studentId: "s1",
        scheduledStart: new Date("2026-10-18T09:00:00Z"),
        status: "completed",
      },
    ]);
    const shifts = await loadTeacherListClockShifts(
      fake,
      TEACHER,
      [
        {
          id: "next",
          studentId: "s1",
          scheduledStart: new Date("2026-10-25T10:00:00Z"),
          status: "scheduled",
          studentTimezone: "America/Mexico_City",
        },
        {
          id: "after",
          studentId: "s1",
          scheduledStart: new Date("2026-11-01T10:00:00Z"),
          status: "scheduled",
          studentTimezone: "America/Mexico_City",
        },
      ],
      NOW,
    );
    expect([...shifts]).toEqual([["next", 60]]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teacherId: "t1",
          studentId: { in: ["s1"] },
          scheduledStart: {
            gte: new Date(NOW.getTime() - CLOCK_CHANGE_LOOKBACK_DAYS * 86_400_000),
            lte: new Date("2026-11-01T10:00:00Z"),
          },
        }),
      }),
    );
  });

  it("returns only listed rows, and fetches nothing when no student has a zone", async () => {
    const { db: fake, findMany } = db([]);
    const shifts = await loadTeacherListClockShifts(
      fake,
      TEACHER,
      [
        {
          id: "x",
          studentId: "s2",
          scheduledStart: new Date("2026-10-25T10:00:00Z"),
          status: "scheduled",
          studentTimezone: null,
        },
      ],
      NOW,
    );
    expect(shifts.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
