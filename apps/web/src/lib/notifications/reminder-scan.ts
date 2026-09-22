import type { PrismaClient } from "@prisma/client";
import type { EnqueueOptions } from "@/lib/jobs/enqueue";
import { maybeEnqueueFiveDayMaterials, maybeEnqueueReminder, type ReminderLeg } from "./reminders";

// Due-scan reminders (docs/architecture/overview.md).
//
// Replaces the former per-booking durable-timer fan-out (Inngest
// schedule-reminders fanned out four `sleepUntil` legs from booking.created).
// A cron scan recomputes due-ness from the booking rows themselves, so nothing
// is a live timer that could be orphaned at the Inngest→pg-boss cutover — the
// audit's key de-risking move. Idempotent: maybeEnqueueReminder dedupes at the
// row level, so re-evaluating a due leg on every tick sends it at most once.
//
// A leg fires when a scan tick T satisfies fireTime <= T < scheduledStart AND
// fireTime > booking.createdAt. The `fireTime > createdAt` guard reproduces the
// old handler's "skip a leg whose fire-time already passed at booking time"
// behavior — a class booked 30 min out never back-fires its 24h/1h legs.
//
// ── Why the cron is hourly, and what makes the 15m leg still exact ──────────
//
// A DB touch buys a fixed 5 minutes of billed Neon compute (the Free plan's
// scale-to-zero timer is not configurable), so the monthly spend is set by how
// many times a day something wakes the database — not by how much work each
// wake does. Measured on production: 96 `*/15` ticks/day cost ~11 active h/day
// ≈ 89 of the 100 free CU-hours/month, of which 8 h/day was pure idle-timer
// with the actual sweep work adding only ~0.7 min per tick. See D-115.
//
// A pure `*/15` poll bought that 4x cost solely to catch the tightest leg on
// time. `scanAndScheduleNextWake` below buys the same precision for a fraction
// of the wakes: the hourly tick fires everything already due AND schedules a
// single delayed `reminder.due` event at the exact moment the next leg comes
// due, which re-enters this same scan. On a day with no classes the chain never
// starts and the hourly tick is the only cost.
//
// The chain is also (re)started at booking creation, by
// inngest/functions/on-booking-created.ts re-running this same scan on every
// `booking.created` (D-115 addendum, 2026-08-16). Without that, a wake is only
// ever armed BY a scan and scans only ran on the tick or on a wake — so a
// booking written between ticks whose next leg fell before the next tick had
// nothing armed for it: a class booked at 10:10 for 11:30 got its 1h leg at
// the 11:00 tick (30 min before class), and one booked at 10:10 for 10:50 —
// legal for a teacher's self-serve booking, which skips the min-advance window
// — never got its 15m leg at all, since the 11:00 tick already excludes it
// (scheduledStart <= now). The creation-time scan arms the wake for exactly
// that leg; the DB is awake anyway (the booking was just written), the scan is
// idempotent, and the hourly tick stays the backstop if the emit is lost.
//
// The chain deliberately carries NO booking identity: a wake is just "re-run
// the scan at time T", and every decision is re-derived from the booking rows
// at that moment. So a class cancelled or rescheduled after its wake was
// scheduled cannot mis-fire — the wake finds nothing due and reschedules from
// the live rows. That preserves the audit's no-orphanable-timer property; the
// only durable state is a <=65-minute event that is re-derived hourly anyway,
// unlike the multi-day `sleepUntil` fan-out Phase 2b-ii deleted.

// There is no 5d leg: the five-days-before class reminder was removed at
// teachers' request, for students and teachers alike.
//
// The tightest leg is 15m, not the 5m it was until 2026-08-08. A 5-minute leg
// can only be served on time by a `*/5` scan, and at one 5-minute wake per tick
// that pins the compute awake 24/7 no matter how the scan is scheduled — the
// wake chain below cannot rescue it, because consecutive fire moments are never
// far enough apart for the compute to suspend between them. 15m is the tightest
// leg that stays affordable.
const LEGS: { which: ReminderLeg; offsetMs: number }[] = [
  { which: "24h", offsetMs: 24 * 60 * 60 * 1000 },
  { which: "1h", offsetMs: 60 * 60 * 1000 },
  { which: "15m", offsetMs: 15 * 60 * 1000 },
];

// The five-day mark outlives the reminder that used to fire there: `t_5d` is
// still a send timing a teacher can pick for class materials, so the scan keeps
// a materials-only pass at that offset (maybeEnqueueFiveDayMaterials). It's also
// what fixes the scan horizon — nothing is due earlier than 5 days out.
const MATERIALS_5D_OFFSET_MS = 5 * 24 * 60 * 60 * 1000;

const HORIZON_MS = MATERIALS_5D_OFFSET_MS; // widest offset — nothing is due earlier
const DEFAULT_LIMIT = 500;

// How far ahead a scan looks when picking the next wake. Must exceed the cron
// interval (hourly) so that consecutive ticks' windows overlap and no fire
// moment can fall into a gap between them; the 5 minutes of slack absorbs a
// late tick. The overlap means two ticks can pick the same moment — hence the
// singletonKey/`id` dedup on the enqueued wake.
export const WAKE_LOOKAHEAD_MS = 65 * 60 * 1000;

// A leg is treated as due once it is within this much of its fire-time, rather
// than strictly at or past it.
//
// This exists for the wake chain, not the cron. A wake is delivered against
// Inngest's clock and evaluated against this process's clock; a few seconds of
// skew between them would make the leg "not due yet" at the instant it was
// armed for. That failure is worse than it looks: the re-scan would try to arm
// the SAME moment again, the singletonKey/`id` dedup would (correctly) drop it
// as a duplicate, and the chain would stall until the next hourly tick — a
// silently hour-late reminder. A minute of grace is far larger than any
// plausible skew, and firing a 15-minute nudge up to 60s early is not a
// difference a student can perceive.
export const DUE_GRACE_MS = 60 * 1000;

export type ReminderScanResult = {
  scanned: number;
  due: number;
  sent: number;
  materialsDue: number;
  materialsSent: number;
  // Earliest leg fire-time strictly ahead of `now` and within the lookahead,
  // or null when nothing comes due that soon. Only the reminder LEGS feed this.
  // The five-day materials mark cannot: its fire-time is scheduledStart-5d, and
  // the query horizon is also scheduledStart<=now+5d, so every visible
  // booking's materials mark is already in the past. A booking that crosses
  // into the horizon between ticks has its materials released by the next
  // hourly tick — up to an hour late, which is immaterial for "materials five
  // days before class" and is exactly the behaviour the */15 scan had.
  nextFireAt: Date | null;
};

export async function scanDueReminders(deps: {
  prisma: Pick<PrismaClient, "booking">;
  now?: Date;
  limit?: number;
}): Promise<ReminderScanResult> {
  const now = deps.now ?? new Date();
  const horizon = new Date(now.getTime() + HORIZON_MS);
  const lookaheadEnd = now.getTime() + WAKE_LOOKAHEAD_MS;

  // Upcoming scheduled bookings only: scheduledStart in (now, now+5d]. A class
  // that already started (scheduledStart <= now) is excluded, so no leg fires
  // after start; the auto-complete sweep transitions it out of `scheduled`.
  const bookings = await deps.prisma.booking.findMany({
    where: {
      status: "scheduled",
      scheduledStart: { gt: now, lte: horizon },
    },
    select: { id: true, teacherId: true, studentId: true, scheduledStart: true, createdAt: true },
    orderBy: { scheduledStart: "asc" },
    take: deps.limit ?? DEFAULT_LIMIT,
  });

  let due = 0;
  let sent = 0;
  let materialsDue = 0;
  let materialsSent = 0;
  let nextFireMs: number | null = null;
  for (const b of bookings) {
    for (const leg of LEGS) {
      const fireTime = new Date(b.scheduledStart.getTime() - leg.offsetMs);
      if (fireTime.getTime() <= now.getTime() + DUE_GRACE_MS && fireTime > b.createdAt) {
        due += 1;
        // maybeEnqueueReminder dedupes + re-checks live status; an already-sent
        // leg is a no-op (sent:false, reason:duplicate).
        const r = await maybeEnqueueReminder({
          bookingId: b.id,
          teacherId: b.teacherId,
          studentId: b.studentId,
          which: leg.which,
        });
        if (r.sent) sent += 1;
        continue;
      }
      // Not yet due — is it the next thing that will be? No createdAt guard is
      // needed on this branch: createdAt <= now < fireTime always holds here.
      // Anything inside the grace window above already fired and `continue`d,
      // so a candidate is always genuinely far enough out to be worth a wake.
      const ms = fireTime.getTime();
      if (ms > now.getTime() && ms <= lookaheadEnd && (nextFireMs === null || ms < nextFireMs)) {
        nextFireMs = ms;
      }
    }

    // Materials-only pass at the five-day mark — same due-ness rule as a leg
    // (fire-time passed, and not back-fired for a booking created after it).
    const materialsFireTime = new Date(b.scheduledStart.getTime() - MATERIALS_5D_OFFSET_MS);
    if (materialsFireTime <= now && materialsFireTime > b.createdAt) {
      materialsDue += 1;
      const r = await maybeEnqueueFiveDayMaterials({
        bookingId: b.id,
        teacherId: b.teacherId,
        studentId: b.studentId,
      });
      if (r.sent) materialsSent += 1;
    }
  }

  return {
    scanned: bookings.length,
    due,
    sent,
    materialsDue,
    materialsSent,
    nextFireAt: nextFireMs === null ? null : new Date(nextFireMs),
  };
}

// The scan as the cron and the wake handler both run it: fire what's due, then
// arm a single delayed `reminder.due` for the next leg that comes due inside
// the lookahead. Both entry points call this, so a wake re-arms the chain the
// same way the hourly tick does.
//
// `enqueue` is injected (rather than importing the seam directly) so the
// backend stays the caller's choice — Inngest today via lib/jobs/enqueue, the
// pg-boss `send` once JOBS_BACKEND flips — and so a test can assert the
// scheduling without a queue.
export async function scanAndScheduleNextWake(deps: {
  prisma: Pick<PrismaClient, "booking">;
  enqueue: (
    name: "reminder.due",
    data: { scheduledFor: string },
    opts: EnqueueOptions,
  ) => Promise<void>;
  now?: Date;
  limit?: number;
}): Promise<ReminderScanResult & { wakeScheduledFor: string | null }> {
  const result = await scanDueReminders(deps);
  if (!result.nextFireAt) return { ...result, wakeScheduledFor: null };

  const scheduledFor = result.nextFireAt.toISOString();
  // Keyed on the moment, not on a booking: two overlapping ticks that pick the
  // same fire moment collapse to one wake, while a genuinely different moment
  // gets its own. `scheduledFor` is carried in the payload for diagnostics only
  // — the handler re-derives everything from the live rows.
  await deps.enqueue(
    "reminder.due",
    { scheduledFor },
    { startAfter: result.nextFireAt, singletonKey: `reminder-wake-${scheduledFor}` },
  );
  return { ...result, wakeScheduledFor: scheduledFor };
}
