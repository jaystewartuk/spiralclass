import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/jobs/enqueue";
import { scanAndScheduleNextWake } from "@/lib/notifications/reminder-scan";

// The reminder wake chain's third entry point (D-115 addendum, 2026-08-16):
// re-run the reminder scan the moment a booking is created.
//
// The gap this closes. `reminder-scan-cron` ticks hourly and serves the tight
// legs (1h, 15m before class) by arming ONE delayed `reminder.due` at the
// exact moment the next leg comes due, handled by on-reminder-due.ts. But a
// wake is only ever armed BY a scan, and scans only ran on the hourly tick or
// on a wake — nothing ran one when a booking was written. So a booking created
// between ticks whose next leg fell before the next tick had no wake armed for
// it at all:
//   * 1h leg: a class booked at 10:10 for 11:30 has its 1h leg due at 10:30;
//     nothing fired until the 11:00 tick — the "one hour before" reminder
//     landed 30 minutes before class (up to 60 min late in general).
//   * 15m leg: a class booked at 10:10 for 10:50 (teacher self-serve bypasses
//     the min-advance window — "already agreed over WhatsApp") has its 15m leg
//     due at 10:35; the 11:00 tick excludes the booking outright
//     (scheduledStart <= now), so that reminder NEVER fired.
// Under the old `*/15` grid the worst case was 15 min late; D-115's "precision
// is unchanged" claim only holds with this function in place.
//
// Why re-run the whole scan rather than arm a wake for just this booking: the
// scan is idempotent (maybeEnqueueReminder dedupes at the row level, and the
// wake is singleton-keyed on its moment), the DB is already awake because the
// booking was just written (so this costs no extra Neon wake window), and it
// keeps a single code path — the cron, the wake handler and this function all
// call scanAndScheduleNextWake, so there is exactly one definition of "what is
// due and what comes next". Every booking creation path emits `booking.created`
// (book-package-slot, the reschedule replacement row, override restore on web
// and mobile, and auto-book via lib/jobs/events.ts), so every path gets it.
//
// The wake this arms carries no booking identity — same as the cron's. It is
// just "re-run the scan at time T": a class cancelled or rescheduled between
// arm and fire simply isn't due when the wake lands, and the re-scan arms the
// next moment off the live rows. The hourly cron remains the backstop, so a
// lost `booking.created` emit costs at most an hour of precision, never the
// reminder itself.
//
// Registered on PRODUCTION ONLY (index.ts's productionOnlyEventFunctions):
// preview registers no crons precisely so no reminder ever fires there, and
// since this function starts the same wake chain, letting it exist on preview
// would have Maestro fixtures receiving reminder emails/pushes.
export const onBookingCreatedFn = inngest.createFunction(
  {
    id: "on-booking-created",
    retries: 1,
    triggers: [{ event: "booking.created" }],
  },
  async ({ step }) =>
    step.run("scan-due-reminders", () => scanAndScheduleNextWake({ prisma, enqueue })),
);
