# Scheduling and booking

Students book classes into a teacher's weekly availability, paying with
credits from a [package](packages.md). A booking is a fixed slot
(`scheduledStart` → `scheduledEnd`) that spends one credit **when it is made**.
Cancelling early is what gives the credit back. Students cancel and reschedule
under a **24-hour boundary** and a **pooled per-package schedule-change
budget**; teachers can override, and every override is audited.

Where a teacher sets her hours, blocked dates and Google Calendar sync:
[teacher-management.md](teacher-management.md).

## "Model B": a class is spent when it is booked

`Package.classesUsed` counts **committed bookings**, not taught classes: every
booking with `countsAgainstPackage = true`. A class is charged to the package
at booking and released only by something that gives it back. The code uses
the name "Model B" for this throughout (`cancel-handler.ts`,
`auto-complete.ts`, `overrides.ts`, `teacher-packages.ts`, `package-usage.ts`).
Charging at completion was rejected because the remaining balance — the number
a student decides against — would be unknowable until every booked class had
happened.

## Slot generation (`lib/slots.ts`)

1. The grid comes from `AvailabilityRule` rows: a weekday, `startTime` /
   `endTime`, and the IANA timezone the rule was **written in**. Changing the
   teacher's profile timezone does not reinterpret existing rules
   ([D-53](../decisions/D-53.md)).
2. Slots run back to back every `classDurationMin + bufferMin` inside each
   window; a slot that does not fit whole is not offered.
3. A slot is dropped if it overlaps a `BlockedDate` or an imported Google
   Calendar busy block.
4. A slot is dropped if it is before `now + minAdvanceH` or at/after
   `now + maxAdvanceDays`.
5. A slot is dropped if it collides with an existing booking's buffer zone,
   using **that booking's own `bufferMinSnapshot`**, not the teacher's current
   buffer.
6. All slot math is UTC on the wire; wall-clock rule times are resolved in the
   rule's own zone first.

## Double-booking is prevented by the database

- Two constraints back every insert, so the picker is a convenience, not the
  guarantee: a partial unique index on `(teacher, scheduled_start)` for active
  bookings, and the GiST `EXCLUDE` constraint `bookings_no_overlap_buffered`
  over `[scheduled_start, buffered_end)` per teacher. `buffered_end` is
  trigger-derived (`scheduled_end + buffer_min_snapshot`).
- Either violation (Prisma `P2002`, Postgres `23P01`) reaches the user as one
  "slot taken" message, never a 500.
- `buffer_min_snapshot` is frozen at insert; a later buffer change never
  resizes an existing booking's zone.

## Booking (`lib/booking/book-package-slot.ts`)

- A booking spends one credit from the student's pool for that teacher, class
  length and seat count: the **soonest-to-expire eligible** credit
  (`lib/booking/credit-ledger.ts`, rules in [packages.md](packages.md)).
- A credit is eligible only if its package is `active`, has capacity, and is
  still valid **at the class's start time**.
- No eligible credit: `package-exhausted` (no capacity) or `package-expired`
  (capacity, but every package lapses before the class).
- The student is always sent `booking_confirmation`; the teacher gets
  `booking_created_teacher` for a booking she did not make herself.
- **Teacher self-serve booking** (`actions/teacher-booking.ts`, from
  `/dashboard/classes/book`) bypasses only her own `minAdvanceH`.
  Availability, blocked dates, buffers and max-advance still apply. It writes
  an `Override` row.

## Cancellation (`lib/cancellation/classify.ts`, `cancel-handler.ts`)

- The boundary is **`scheduledStart` minus the server clock**, in absolute
  time. Timezones play no part; a client clock is never used.
- **Exactly 24h00m00s ahead counts as ≥24h.** Anything less, including a class
  already started, is <24h.
- **Student cancel, <24h**: always allowed; the class is forfeited
  (`classesUsed` stays) and no schedule-change unit is spent.
- **Student cancel, ≥24h**: the class is returned (`classesUsed − 1`) and one
  schedule-change unit is spent. With the budget exhausted, the refundable
  cancel is refused (`schedule-changes-exhausted`); she can still forfeit the
  class or ask the teacher.
- **Teacher cancel** (`handleTeacherCancel`) always returns the class, at any
  time, and spends no budget. It also works on `completed` and `no_show`
  bookings, which makes it the "forgive a past class" tool. A reason is
  required and an `Override` row is written.
- The `classesUsed` decrement is floor-guarded: if it would go below 0 the
  cancel still completes, the decrement is skipped and logged as an error.

## The pooled schedule-change budget

- **Allowance = the package's `classesTotal`**, pooled across the package and
  counted in `Package.scheduleChangesUsed`.
- A ≥24h student cancel and a student reschedule both spend from it. Pooling
  closes the cancel-then-rebook loop a per-booking counter allowed.
- The unit is charged at **cancel** time, since a rebook looks like any first
  booking.
- The budget is re-checked inside the mutating transaction; a concurrent
  change on another booking of the same package that spent the last unit
  makes the later one fail with `schedule-changes-exhausted`.
- `Booking.rescheduleCount` is lineage beside `rescheduleOfBookingId` and gates
  nothing; the pool is the only cap.
- A teacher waiving a ≥24h cancellation returns the unit it spent. Restoring a
  cancelled class to `scheduled` re-claims its credit but does not return the
  unit.

## Reschedule (`lib/cancellation/reschedule-handler.ts`)

- A student may start a reschedule only if the booking is `scheduled`, the
  budget has a unit left, and the class is ≥24h away. Otherwise:
  `booking-not-scheduled`, `schedule-changes-exhausted` or `lt24h`.
- The new slot must pass the full slot generator.
- The old booking's credit is released and the new one's claimed in the same
  transaction, so the balance does not change; one budget unit is spent.
- The old row is set to `rescheduled` **before** the new row is inserted, so a
  small move does not collide with the row it replaces. The new row carries
  `rescheduleOfBookingId` and `rescheduleCount + 1`.
- Concurrent double-submits are guarded by conditional `updateMany`s; the
  loser gets `slot-conflict`. A package deleted mid-flow is `package-not-found`.
- Both parties are told, with the old time (`reschedule_confirm`,
  `reschedule_confirm_teacher`).

**Teacher moves** (`actions/teacher-reschedule.ts`, "Manage class" → "Change
date and time" at `/dashboard/classes/[bookingId]/reschedule`) use the same
handler. She is exempt from the 24-hour rule and spends no budget
(`spendScheduleChange: false`); everything else binds, except her own
`minAdvanceH`. Only a `scheduled` class can be moved. An `Override` row
(`teacher_reschedule_class`) is written in the same transaction; the student
gets `reschedule_confirm` and the teacher's mirror is skipped. Errors come
back as codes (`lib/cancellation/teacher-reschedule-errors.ts`): `not-scheduled`,
`same-slot`, `past-slot`, plus the slot and package codes above.

## Completion and no-shows (`lib/cancellation/auto-complete.ts`)

- An hourly sweep (`auto-complete-sweep`) flips a `scheduled` booking whose
  `scheduledEnd` has passed to `completed`. It changes no counts. The update is
  guarded on `status = scheduled`, so a rerun is a no-op.
- There is no "mark as completed" button. `markBookingComplete`
  (`actions/overrides.ts`) is not surfaced in the UI.
- A teacher can record a **no-show** on a past `scheduled` class or on a
  `completed` one. It clears `completedAt`, writes an `Override` row and sends
  `no_show_student`, so a late relabel sends a late message. A no-show counts
  as delivered, like a completed class. `restoreClass` undoes it.

## Blocking dates

- Creating a `BlockedDate` (`lib/cancellation/blocked-date-collision.ts`) cancels every `scheduled` booking whose interval
  **overlaps** the range, through the teacher-cancel path: class returned,
  `Override` row written, student notified.
- Collisions are cancelled in batches of `COLLISION_CANCEL_CONCURRENCY` to
  spare the connection pool.
- Google Calendar busy blocks only hide slots; they never cancel an existing
  booking.

There is no primitive for opening one extra slot outside the weekly rules. A
teacher either changes her rules or books the student herself.

## Student flows

- **Book**: `/my-classes/book` shows open slots for her package's class
  length. The server re-runs the full slot check before writing; the shown
  slots are a snapshot.
- **Cancel**: from `/my-classes/[bookingId]` (`actions/cancel-booking.ts` →
  `handleStudentCancel`). Outcomes: `ok` with the timing, `not-found`,
  `wrong-status`, `schedule-changes-exhausted`. Notices are worded for the
  outcome (`cancel_lt24h`, `cancel_gte24h_with_reschedule` and the teacher
  mirrors).
- **Reschedule**: `/my-classes/[bookingId]/reschedule`; eligibility is checked
  before the picker shows.

## Error codes

| Code                         | Where                   | Meaning                                            |
| ---------------------------- | ----------------------- | -------------------------------------------------- |
| `slot-unavailable`           | book, reschedule        | The slot no longer passes generation               |
| `slot-taken`                 | book                    | Collided at insert                                 |
| `package-exhausted`          | book                    | No package has capacity                            |
| `package-expired`            | book                    | Capacity exists but lapses before the class        |
| `not-found` / `wrong-status` | cancel                  | Not the caller's booking, or no longer `scheduled` |
| `schedule-changes-exhausted` | ≥24h cancel, reschedule | The pooled budget is spent                         |
| `booking-not-scheduled`      | reschedule eligibility  | Booking is not `scheduled`                         |
| `lt24h`                      | reschedule eligibility  | Less than 24 hours ahead (students only)           |
| `slot-conflict`              | reschedule              | Collision, or a concurrent change won              |
| `package-not-found`          | reschedule              | The package was deleted mid-flow                   |

## Data

- **AvailabilityRule** — weekday, start/end time, frozen timezone.
- **BlockedDate** — a range that removes availability and cancels colliding
  classes.
- **Booking** — `scheduledStart` / `scheduledEnd`, `status`,
  `countsAgainstPackage`, `rescheduleOfBookingId`, `rescheduleCount`,
  `bufferMinSnapshot`, `bufferedEnd`.
- **Package** — see [packages.md](packages.md).
- **Override** — audit log of teacher and admin interventions, with
  before/after JSON and a reason; visible to the student in her class history.

## Permissions

| Action      | Student (own)                   | Teacher (own students)                                       | Admin          |
| ----------- | ------------------------------- | ------------------------------------------------------------ | -------------- |
| View        | Yes                             | Yes                                                          | Yes (`/admin`) |
| Book        | Yes                             | Yes (self-serve)                                             | —              |
| Cancel      | Yes (24h rule and budget apply) | Yes (`scheduled`, `completed`, `no_show`; returns the class) | —              |
| Reschedule  | Yes (eligibility applies)       | Yes (`scheduled` only; no 24h rule, no budget)               | —              |
| Block dates | No                              | Yes                                                          | —              |

No booking needs approval; a valid slot is booked at once.
