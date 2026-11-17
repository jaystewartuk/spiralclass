import type { PrismaClient } from "@prisma/client";
import { clockChangeShiftsByBooking } from "@spiralclass/shared";

// The teacher's class list side of "the clocks have changed since the last
// class" (issue 229; the rule is packages/shared/src/clock-change.ts). The
// student portal already loads every class it shows and needs nothing more; the
// teacher's list is a page of upcoming rows, so the class before each student's
// first row has to be fetched.

/**
 * How far back to look for a student's previous class. A class after a longer
 * break than this gets no note: the comparison is "since your last class", and
 * a reader four months on has no routine for it to correct.
 */
export const CLOCK_CHANGE_LOOKBACK_DAYS = 120;

const REFERENCE_STATUSES = ["scheduled", "completed", "no_show"] as const;

type Db = Pick<PrismaClient, "booking">;

export type ClockChangeRow = {
  id: string;
  studentId: string;
  scheduledStart: Date;
  status: string;
  studentTimezone: string | null;
};

/**
 * Shift in minutes for each listed class whose student's clock moved since that
 * student's previous class with this teacher; rows that did not move are absent.
 */
export async function loadTeacherListClockShifts(
  db: Db,
  teacher: { id: string; timezone: string },
  rows: readonly ClockChangeRow[],
  now: Date,
): Promise<Map<string, number>> {
  // A student with no zone gets no note, so do not fetch history for one.
  const zoned = rows.filter((r) => r.studentTimezone);
  if (zoned.length === 0) return new Map();
  const studentTz = new Map(zoned.map((r) => [r.studentId, r.studentTimezone]));
  const lastStart = Math.max(...zoned.map((r) => r.scheduledStart.getTime()));
  const history = await db.booking.findMany({
    where: {
      teacherId: teacher.id,
      studentId: { in: [...studentTz.keys()] },
      status: { in: [...REFERENCE_STATUSES] },
      scheduledStart: {
        gte: new Date(now.getTime() - CLOCK_CHANGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
        lte: new Date(lastStart),
      },
    },
    select: { id: true, studentId: true, scheduledStart: true, status: true },
  });
  // The listed rows are in `history` too; merging by id keeps either copy once.
  const asRef = (b: { id: string; studentId: string; scheduledStart: Date; status: string }) => ({
    id: b.id,
    pairKey: b.studentId,
    scheduledStart: b.scheduledStart,
    status: b.status,
  });
  const byId = new Map(history.map((b) => [b.id, asRef(b)]));
  for (const r of zoned) byId.set(r.id, asRef(r));
  const all = clockChangeShiftsByBooking([...byId.values()], (b) => ({
    studentTz: studentTz.get(b.pairKey) ?? null,
    teacherTz: teacher.timezone,
  }));
  const listed = new Set(rows.map((r) => r.id));
  return new Map([...all].filter(([id]) => listed.has(id)));
}
