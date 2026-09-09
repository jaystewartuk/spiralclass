import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { generateSlots, type GenerateSlotsInput } from "@/lib/slots";

// Shared fixture: Alicia Moreno in Mexico City, Mon–Fri 09:00–13:00 + 16:00–19:00.
const TZ = "America/Mexico_City";

const TEACHER = {
  timezone: TZ,
  bufferMin: 10,
  minAdvanceH: 2,
  maxAdvanceDays: 60,
};

const FULL_AVAILABILITY = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: "09:00", endTime: "13:00", timezone: TZ },
  { weekday, startTime: "16:00", endTime: "19:00", timezone: TZ },
]);

// `now` anchored well before the test day so min/max windows don't filter.
// 2026-04-13 (Monday) is the reference "now"; tests query 2026-04-15 (Wed)
// which is 2 days ahead — inside the 60-day max, past the 2-hour min.
const NOW = fromZonedTime("2026-04-13T08:00:00", TZ);

function base(overrides: Partial<GenerateSlotsInput> = {}): GenerateSlotsInput {
  return {
    date: "2026-04-15", // Wednesday
    classDurationMin: 50,
    teacher: TEACHER,
    availabilityRules: FULL_AVAILABILITY,
    blockedDates: [],
    existingBookings: [],
    now: NOW,
    ...overrides,
  };
}

describe("generateSlots", () => {
  it("emits no slots when no availability rule matches the weekday", () => {
    const result = generateSlots(base({ date: "2026-04-19" })); // Sunday
    expect(result).toEqual([]);
  });

  it("50-min class + 10-min buffer: 09:00-13:00 yields 4 slots (09, 10, 11, 12)", () => {
    const result = generateSlots(
      base({
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
      }),
    );
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T10:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T11:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T12:00:00", TZ).toISOString(),
    ]);
  });

  it("two rules on same day concat and emit ordered slots (sorted)", () => {
    const result = generateSlots(base());
    // Morning rule: 4 slots. Afternoon rule 16:00-19:00 with 50+10 step:
    // 16:00, 17:00, 18:00 — 18:00 + 50 = 18:50 ≤ 19:00 ✓ → 3 slots. Total 7.
    expect(result).toHaveLength(7);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startUtc.getTime()).toBeGreaterThan(result[i - 1].startUtc.getTime());
    }
  });

  it("90-min package on the same rule yields 2 slots (09:00, 10:40)", () => {
    const result = generateSlots(
      base({
        classDurationMin: 90,
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
      }),
    );
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T10:40:00", TZ).toISOString(),
    ]);
  });

  it("drops candidates inside a blocked_dates range", () => {
    const blocked = {
      startsAt: fromZonedTime("2026-04-15T10:00:00", TZ),
      endsAt: fromZonedTime("2026-04-15T12:30:00", TZ),
    };
    const result = generateSlots(
      base({
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
        blockedDates: [blocked],
      }),
    );
    // 09:00 survives (09:00–09:50 ends before block). 10:00, 11:00, 12:00
    // all overlap the block → dropped.
    expect(result).toHaveLength(1);
    expect(result[0].startUtc.toISOString()).toBe(
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
    );
  });

  it("drops candidates earlier than now + minAdvanceH", () => {
    // Set `now` to 2026-04-15 08:00 local (=10:00 would be only 2h away → minStart = 10:00).
    // With minAdvanceH=2, 09:00 is dropped, 10:00 is the boundary (>= keeps it).
    const now = fromZonedTime("2026-04-15T08:00:00", TZ);
    const result = generateSlots(
      base({
        now,
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
      }),
    );
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T10:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T11:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T12:00:00", TZ).toISOString(),
    ]);
  });

  it("drops candidates later than now + maxAdvanceDays", () => {
    // maxAdvanceDays=1: from a now at 2026-04-14 00:00 local, only slots
    // within ~24h count. 2026-04-15 morning (day later) is outside the cutoff.
    const now = fromZonedTime("2026-04-14T00:00:00", TZ);
    const result = generateSlots(
      base({
        now,
        teacher: { ...TEACHER, maxAdvanceDays: 1 },
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
      }),
    );
    expect(result).toEqual([]);
  });

  it("drops candidates that collide with existing bookings, enforcing buffer on both sides", () => {
    const existing = {
      scheduledStart: fromZonedTime("2026-04-15T11:00:00", TZ),
      scheduledEnd: fromZonedTime("2026-04-15T11:50:00", TZ),
    };
    const result = generateSlots(
      base({
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
        existingBookings: [existing],
      }),
    );
    // 09:00 (09:00-09:50) — ok, gap > buffer to 11:00.
    // 10:00 (10:00-10:50) — ends 10:50; booking starts 11:00; buffer=10min → 10:50+10 = 11:00, touches. guardedEnd=11:00, bookingStart=11:00 → overlap? intervalsOverlap checks strict < so 10:50+10 = 11:00, b.start=11:00, a.end=11:00 → not overlap. Ok kept.
    // Actually my guardedEnd is c.endUtc + bufferMs = 10:50 + 10 = 11:00; b.scheduledStart = 11:00. 11:00 < 11:00 false → no overlap. Kept.
    // 11:00 — same as booking → dropped.
    // 12:00 (12:00-12:50): booking ends 11:50; guardedStart of candidate = 11:50 (12:00 - 10). bookingEnd = 11:50. 11:50 < 11:50 false → not overlap. Kept.
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T10:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T12:00:00", TZ).toISOString(),
    ]);
  });

  it("buffer is enforced on both sides — a candidate ending inside the buffer of a booking is dropped", () => {
    // Use a 20-min buffer to force a real collision.
    const teacher20 = { ...TEACHER, bufferMin: 20 };
    const existing = {
      scheduledStart: fromZonedTime("2026-04-15T11:00:00", TZ),
      scheduledEnd: fromZonedTime("2026-04-15T11:50:00", TZ),
    };
    const result = generateSlots(
      base({
        teacher: teacher20,
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
        existingBookings: [existing],
      }),
    );
    // Step = 50+20 = 70min. Candidates: 09:00 (ends 09:50), 10:10 (ends 11:00),
    // 11:20 (ends 12:10), 12:30 — but 12:30 + 50 > 13:00 → stops earlier.
    // Actually 11:20 + 50 = 12:10 ≤ 13:00 ✓ → kept in raw. Next: 12:30 + 50 = 13:20 > 13:00 → stop.
    // So raw candidates: 09:00, 10:10, 11:20.
    // 10:10 ends 11:00; guardedEnd = 11:00 + 20 = 11:20 > bookingStart 11:00 → overlap → dropped.
    // 11:20 starts inside booking (11:00–11:50) → dropped.
    // 09:00 ends 09:50; guardedEnd = 10:10 < 11:00 → kept.
    expect(result).toHaveLength(1);
    expect(result[0].startUtc.toISOString()).toBe(
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
    );
  });

  it("accepts a Date for `date` and resolves weekday in the teacher's timezone", () => {
    // 2026-04-15 05:00 UTC is still 2026-04-14 23:00 in Mexico City (UTC-6,
    // no DST in CDMX since 2022). Wednesday in UTC is Tuesday locally.
    const result = generateSlots(base({ date: new Date("2026-04-15T05:00:00Z") }));
    // Tuesday has the same full-availability rules → 7 slots like the Wed case.
    expect(result).toHaveLength(7);
  });
});

// D-53: a rule is interpreted in the zone it was WRITTEN in (its own `timezone`
// snapshot), never the live teacher zone. This is what stops a relocating
// teacher from silently desyncing their rules from already-booked UTC instants.
describe("generateSlots — overlapping rules on one weekday", () => {
  // Two rules covering Wed 09:00-12:00 and Wed 10:00-13:00 each generate their
  // own grid from their own start, so 10:00 and 11:00 fall out of BOTH. Nothing
  // downstream collapses them — the blocked/window/booking filters keep or drop
  // both copies together — so the student's picker used to list those times
  // twice, and the slot lists (keyed on `startUtc.toISOString()`) rendered
  // duplicate React keys.
  const OVERLAPPING = [
    { weekday: 3, startTime: "09:00", endTime: "12:00", timezone: TZ },
    { weekday: 3, startTime: "10:00", endTime: "13:00", timezone: TZ },
  ];

  it("emits each start instant exactly once", () => {
    const result = generateSlots(
      base({
        classDurationMin: 60,
        teacher: { ...TEACHER, bufferMin: 0 },
        availabilityRules: OVERLAPPING,
      }),
    );
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T10:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T11:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T12:00:00", TZ).toISOString(),
    ]);
  });

  it("keeps the union of both rules' coverage while de-duplicating", () => {
    const result = generateSlots(
      base({
        classDurationMin: 60,
        teacher: { ...TEACHER, bufferMin: 0 },
        availabilityRules: OVERLAPPING,
      }),
    );
    const starts = result.map((s) => s.startUtc.getTime());
    expect(new Set(starts).size).toBe(starts.length);
    // 09:00 comes only from the first rule, 12:00 only from the second.
    expect(starts).toHaveLength(4);
  });

  it("leaves non-overlapping rules that merely touch at an endpoint alone", () => {
    const result = generateSlots(
      base({
        classDurationMin: 60,
        teacher: { ...TEACHER, bufferMin: 0 },
        availabilityRules: [
          { weekday: 3, startTime: "09:00", endTime: "11:00", timezone: TZ },
          { weekday: 3, startTime: "11:00", endTime: "13:00", timezone: TZ },
        ],
      }),
    );
    expect(result.map((s) => s.startUtc.toISOString())).toEqual([
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T10:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T11:00:00", TZ).toISOString(),
      fromZonedTime("2026-04-15T12:00:00", TZ).toISOString(),
    ]);
  });
});

describe("generateSlots — per-rule timezone binding (D-53)", () => {
  const MADRID = "Europe/Madrid";

  it("anchors slots to the rule's own zone, not the passed teacher zone", () => {
    // Rule frozen in Mexico City; teacher has since relocated and changed their
    // account zone to Madrid. The 09:00 slot must still be 09:00 Mexico City.
    const result = generateSlots(
      base({
        teacher: { ...TEACHER, timezone: MADRID },
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
      }),
    );
    expect(result[0].startUtc.toISOString()).toBe(
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
    );
    // Sanity: it is NOT anchored to 09:00 Madrid (the live teacher zone).
    expect(result[0].startUtc.toISOString()).not.toBe(
      fromZonedTime("2026-04-15T09:00:00", MADRID).toISOString(),
    );
  });

  it("keeps rules and already-booked instants consistent after a teacher relocates", () => {
    // A booking was made at 09:00 Mexico City while the teacher lived there.
    // The teacher then moved to Madrid and changed their account zone. Because
    // the rule stayed frozen in Mexico City, the generator still targets the
    // exact instant the booking sits on — so the collision filter removes that
    // one slot and nothing drifts. (Were the rule reinterpreted in Madrid, the
    // generated 09:00 would be a different instant and the booking would leak
    // through as still-bookable — the desync this fix prevents.)
    const bookedStart = fromZonedTime("2026-04-15T09:00:00", TZ);
    const bookedEnd = new Date(bookedStart.getTime() + 50 * 60_000);

    const result = generateSlots(
      base({
        teacher: { ...TEACHER, timezone: MADRID },
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: TZ }],
        existingBookings: [{ scheduledStart: bookedStart, scheduledEnd: bookedEnd }],
      }),
    );

    const iso = result.map((s) => s.startUtc.toISOString());
    // The booked 09:00 instant is gone (collision); the later slots survive.
    expect(iso).not.toContain(bookedStart.toISOString());
    expect(iso).toContain(fromZonedTime("2026-04-15T11:00:00", TZ).toISOString());
  });

  it("falls back to the teacher zone when a rule arrives without one (defensive)", () => {
    // Legacy/wire safety: a rule missing its timezone snapshot is interpreted
    // in the teacher zone, matching pre-D-53 behavior rather than throwing.
    const result = generateSlots(
      base({
        teacher: { ...TEACHER, timezone: TZ },
        availabilityRules: [{ weekday: 3, startTime: "09:00", endTime: "13:00", timezone: "" }],
      }),
    );
    expect(result[0].startUtc.toISOString()).toBe(
      fromZonedTime("2026-04-15T09:00:00", TZ).toISOString(),
    );
  });
});

// Timezone audit: generateSlots had zero coverage of an actual DST
// transition day — every existing fixture used Mexico City (no DST since
// 2022) or stayed within one season. These pin down real, verified
// date-fns-tz behavior (computed independently via `fromZonedTime`, not
// hand-derived) so a library upgrade or refactor can't silently change it.
describe("generateSlots — DST transition days (America/New_York)", () => {
  const NY = "America/New_York";
  const nyTeacher = { timezone: NY, bufferMin: 0, minAdvanceH: 2, maxAdvanceDays: 60 };

  it("spring-forward (2026-03-08, 2:00am skips to 3:00am): no crash, candidates converted and sorted", () => {
    // 01:00-05:00 rule, 50-min classes, 0 buffer → wall-clock candidates at
    // 01:00, 01:50, 02:40, 03:30. 02:40 falls inside the nonexistent hour.
    const result = generateSlots(
      base({
        date: "2026-03-08",
        teacher: nyTeacher,
        now: fromZonedTime("2026-03-01T00:00:00", NY),
        availabilityRules: [{ weekday: 0, startTime: "01:00", endTime: "05:00", timezone: NY }],
      }),
    );
    // All 4 candidates survive — a nonexistent wall-clock time does not throw
    // or silently drop the slot.
    expect(result).toHaveLength(4);
    const iso = result.map((s) => s.startUtc.toISOString());
    // date-fns-tz resolves the nonexistent 02:40 as if already past the jump
    // (EDT, UTC-4) — 2026-03-08T06:40:00.000Z — which lands BEFORE the real
    // 01:50 EST candidate (06:50Z). generateSlots sorts its output by UTC
    // instant, so the final order is 01:00, 02:40, 01:50, 03:30 by wall
    // clock, even though 02:40 is the later-looking label. Known edge case
    // (see that audit) — not fixed here since a rule reaching
    // into 2-3am local is not a realistic teaching-hours case, but pinned so
    // it's visible rather than silently different after a library bump.
    expect(iso).toEqual([
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T06:40:00.000Z", // 02:40 (nonexistent → resolved as EDT)
      "2026-03-08T06:50:00.000Z", // 01:50 EST
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
    ]);
    // Every candidate is still a real, distinct 50-minute slot end-to-end.
    for (const s of result) {
      expect(s.endUtc.getTime() - s.startUtc.getTime()).toBe(50 * 60_000);
    }
  });

  it("fall-back (2026-11-01, 2:00am repeats as 1:00am): candidates stay ordered, no duplicate/negative gaps", () => {
    // 00:00-04:00 rule, 50-min classes, 0 buffer → candidates at 00:00, 00:50,
    // 01:40, 02:30. 01:40 falls in the repeated hour (occurs twice); the
    // wall-clock stepper only ever emits it once (resolved as the FIRST/EDT
    // occurrence) — the second (EST) occurrence of 1-2am is never offered as
    // a separate slot. Documented limitation: no
    // crash and no ordering inversion, but ~1h of real bookable time on the
    // repeated hour is unreachable if a rule extends into it.
    const result = generateSlots(
      base({
        date: "2026-11-01",
        teacher: nyTeacher,
        now: fromZonedTime("2026-10-25T00:00:00", NY),
        availabilityRules: [{ weekday: 0, startTime: "00:00", endTime: "04:00", timezone: NY }],
      }),
    );
    expect(result).toHaveLength(4);
    const iso = result.map((s) => s.startUtc.toISOString());
    expect(iso).toEqual([
      "2026-11-01T04:00:00.000Z", // 00:00 EDT
      "2026-11-01T04:50:00.000Z", // 00:50 EDT
      "2026-11-01T05:40:00.000Z", // 01:40 EDT (first/only occurrence offered)
      "2026-11-01T07:30:00.000Z", // 02:30 EST
    ]);
    // Strictly increasing UTC order — the transition doesn't invert anything
    // on the fall-back side (unlike the spring-forward gap above).
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startUtc.getTime()).toBeGreaterThan(result[i - 1].startUtc.getTime());
    }
  });
});

// Regression: the collision filter used the teacher's CURRENT buffer for every
// existing booking, but the DB `bookings_no_overlap_buffered` constraint guards
// each booking by its own frozen `bufferMinSnapshot`. After a teacher LOWERS
// their buffer, the picker offered slots the DB then deterministically rejected
// (surfaced as a misleading "booked by someone else"). The filter now mirrors
// the DB exactly, using each booking's snapshot.
describe("per-booking buffer snapshot", () => {
  const NO_BUFFER_TEACHER = { timezone: TZ, bufferMin: 0, minAdvanceH: 2, maxAdvanceDays: 60 };
  const booking = {
    scheduledStart: fromZonedTime("2026-04-15T10:40:00", TZ),
    scheduledEnd: fromZonedTime("2026-04-15T11:30:00", TZ),
  };
  const elevenThirty = fromZonedTime("2026-04-15T11:30:00", TZ).getTime();

  it("guards an existing booking by its OWN snapshot, not the teacher's current buffer", () => {
    // Booking was made when the buffer was 30 min; the teacher has since set it to 0.
    const result = generateSlots(
      base({
        teacher: NO_BUFFER_TEACHER,
        existingBookings: [{ ...booking, bufferMinSnapshot: 30 }],
      }),
    );
    // 11:30 sits inside the booking's frozen 30-min buffer (reserved until 12:00),
    // exactly what the DB EXCLUDE constraint rejects — so it must not be offered.
    expect(result.some((s) => s.startUtc.getTime() === elevenThirty)).toBe(false);
  });

  it("falls back to the current buffer when no snapshot is supplied (prior behaviour)", () => {
    const result = generateSlots(base({ teacher: NO_BUFFER_TEACHER, existingBookings: [booking] }));
    // With current buffer 0 and no frozen snapshot, 11:30 is adjacent-but-clear.
    expect(result.some((s) => s.startUtc.getTime() === elevenThirty)).toBe(true);
  });
});
