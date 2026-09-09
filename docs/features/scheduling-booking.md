# Scheduling & Booking

## Overview

Students book classes against a teacher's recurring weekly availability using
class credits from a purchased **Package**. A booking is a fixed slot
(`scheduledStart` → `scheduledEnd`) tied to one credit; once booked, that
credit is treated as "spent" immediately (**Model B: committed at
reservation**, not at completion) — cancelling early is what gives it back,
not the class happening. Students can cancel or reschedule within rules built
around a hard **24-hour boundary** and a **pooled per-package "schedule
change" budget**. Teachers can override the system directly (self-serve
booking on a student's behalf, blocking dates, forgiving a class) with every
intervention logged to an audit trail. The whole flow ships on web (Next.js
Server Actions/RSC).

Source of truth: `MVP.md §6.5/§6.6/§13.6/§13.11` (referenced throughout the
code), and the files below.

## User Stories

- As a **student**, I want to see a teacher's open slots and book one with a
  class from my package, so I can schedule my next lesson.
- As a **student**, I want to cancel a class I can no longer attend, and know
  in advance whether I'll get the class back or lose it.
- As a **student**, I want to move a class to a different day/time without
  losing the credit, as long as I'm not cutting it too close.
- As a **teacher**, I want to book a class on a student's behalf (e.g. one
  agreed over WhatsApp) without being blocked by my own advance-notice rule.
- As a **teacher**, I want to cancel or "forgive" a class (including one that
  already happened) and have it returned to the student's package.
- As a **teacher**, I want to block out a date range (vacation, sick day) and
  have any classes that fall inside it automatically cancelled and the
  student notified, without losing their credit.
- As a **student/teacher**, I want double-booking to be structurally
  impossible, even under concurrent requests from two devices.

## Business Rules (exhaustive)

### Availability & slot generation (`lib/slots.ts`, §13.11)

1. A teacher's bookable grid is built from `AvailabilityRule` rows (one
   weekday + `startTime`/`endTime` + the IANA timezone the rule was **written
   in**, frozen at save time — not the teacher's live current timezone; see
   D-53). Changing a teacher's profile timezone does not reinterpret existing
   rules.
2. Slots are generated back-to-back at `classDurationMin + bufferMin`
   intervals inside each rule's window (no partial trailing slot that doesn't
   fit the full class length).
3. A candidate slot is excluded if it overlaps any `BlockedDate` range or any
   imported Google Calendar "busy" block (Google Calendar sync is optional,
   additive to `BlockedDate`).
4. A candidate slot is excluded if it falls before `now + minAdvanceH` hours
   or at/after `now + maxAdvanceDays` days (both teacher-configured).
5. A candidate slot is excluded if it collides with any existing `scheduled`
   booking's own buffer zone — buffers are compared using **each existing
   booking's own frozen `bufferMinSnapshot`**, not the teacher's current
   buffer setting, so lowering the buffer later never invalidates a slot the
   DB would still reject for an older booking's larger reserved zone.
6. All slot math happens in UTC on the wire; wall-clock rule times are
   resolved in the rule's own timezone before conversion.

### Double-booking prevention (race-proofed at the database layer)

7. Two independent DB constraints back every insert, so the read-time slot
   picker is a convenience, not the actual guarantee: a partial unique index
   on exact `(teacher, scheduled_start)` for active bookings, and a GiST
   `EXCLUDE` constraint (`bookings_no_overlap_buffered`) over
   `[scheduled_start, buffered_end)` per teacher. `buffered_end` is a
   DB-trigger-derived column (`scheduled_end + buffer_min_snapshot`), so it
   can never drift from the two inputs it's computed from.
8. Any of these three failure modes (P2002 exact-start collision, or Postgres
   error 23P01 from either EXCLUDE constraint) is surfaced to the user as one
   friendly "slot taken" error, never a 500.
9. `buffer_min_snapshot` is frozen onto a booking (or its reschedule
   replacement) at insert time — a later teacher buffer change never
   retroactively resizes an existing booking's protection zone.

### Booking creation (`lib/booking/book-package-slot.ts`)

10. A booking spends **one class credit** from the student's pool of active
    packages with that teacher **at that class length** — the credit
    consumed is the pool's **soonest-to-expire eligible one** (FIFO-by-expiry
    across all the student's active packages with the teacher, not
    necessarily the package the student thinks they're spending from), atomic
    and race-safe.
11. A credit is only eligible if it's still valid (not expired) **at the
    class's start time**, not merely at the moment of booking.
12. If no eligible credit exists: `package-exhausted` (no capacity left) or
    `package-expired` (capacity exists but every eligible package has already
    lapsed by the class start).
13. A teacher booking a slot herself (self-serve, e.g. "the student agreed
    over WhatsApp") can bypass her own `minAdvanceH` rule only — availability
    windows, blocked dates, buffers, and max-advance still fully apply. This
    bypass can optionally be logged as an `Override` audit row.
14. On success, a `booking_confirmation` notification is always queued to the
    student; a mirrored `booking_created` notification to the teacher is
    optional (used for student-initiated bookings, skipped when the teacher
    books it herself).

### Cancellation — the 24-hour rule (`lib/cancellation/classify.ts`, §6.6)

> **"Model B" — the term the code uses, defined once, here.** `classesUsed` is a
> ledger of **committed bookings**, not of taught classes: a class is charged
> against the package the moment it is booked, and released only if something
> refunds it. Fourteen files say "Model B" on the strength of this paragraph —
> the schema, `cancel-handler.ts`, `auto-complete.ts`, `overrides.ts`,
> `teacher-packages.ts`, `package-usage.ts`, the roster importer and their
> tests — so every rule below is about **when the charge is released**, never
> about when it is made. The alternative — charging at
> completion — was not chosen because it makes a package's remaining balance
> unknowable until every booked class has happened, which is the number a
> student is deciding against.

15. **The boundary is measured against `scheduledStart`, in absolute UTC
    delta from the server clock** — never `scheduledEnd`, and never a client
    clock. Timezone is irrelevant to the math (server is the sole source of
    truth, §13.6).
16. **Boundary is inclusive on the eligible side**: exactly 24h00m00s ahead
    counts as `gte24h` (refundable); 23h59m59s or less counts as `lt24h`
    (forfeit). A cancel attempted after the class has already started is
    always classified `lt24h`.
17. **`< 24h` before start (student-initiated cancel)**: the class stays
    **forfeited** — `classesUsed` is NOT restored, no schedule-change unit is
    spent (a penalty isn't a "move"). This is always allowed — a student can
    always cancel, they just don't get the class back.
18. **`≥ 24h` before start (student-initiated cancel)**: the class credit is
    refunded (`classesUsed -= 1`) **and one unit of the package's pooled
    "schedule change" budget is spent** (see below) — unless that budget is
    already exhausted, in which case the refundable cancel is refused
    outright (`schedule-changes-exhausted`). The student can still forfeit
    the class instead (a `<24h` cancel is never blocked by the budget) or ask
    the teacher to cancel it for them (a teacher cancel always refunds,
    regardless of timing or budget — see below).
19. **Teacher-initiated cancel** always refunds the class (`classesUsed -=
1`) and never penalizes the student, regardless of how close to the class
    time it happens. It also works on `completed` and `no_show` bookings —
    the same action doubles as a "forgive a past class" tool (e.g. the
    student had a legitimate reason for missing it).
20. Every teacher cancel writes an `Override` audit row (before/after JSON,
    reason) so the student-facing history can show why the class moved.

### The pooled "schedule change" budget (§6.6)

21. **Budget = `classesTotal` of the package** — one pooled move allowed per
    class in the package, shared across the whole package (not per-booking).
22. Both a `≥24h` refundable student cancel and a reschedule draw from the
    **same** pooled counter (`Package.scheduleChangesUsed`). This closes a
    loophole from an earlier design (a per-booking `reschedule_count < 1`
    cap): without pooling, a student could cancel `≥24h` (refund), rebook a
    brand-new row that starts its own counter at 0, and repeat indefinitely
    for unlimited free moves.
23. The budget check is re-verified **inside** the mutating transaction (not
    just at the earlier read-time eligibility check) — a concurrent
    cancel/reschedule against a _different_ booking in the same package can
    legitimately spend the last unit between the two reads; the later
    transaction detects this and rolls back cleanly, reporting
    `schedule-changes-exhausted` rather than over-spending the budget.

### Reschedule (`lib/cancellation/reschedule-handler.ts`, §6.6)

24. A student can enter the reschedule flow only if **all** hold: (a) the
    booking is still `status = scheduled` (not already canceled/completed —
    those need a teacher override), (b) the package has schedule-change
    budget left, (c) the class is `≥24h` out (same classifier as a cancel).
25. Rescheduling does **not** change quota — the old booking's credit is
    released (`countsAgainstPackage = false`) at the exact same moment the
    new replacement booking's credit is claimed (`countsAgainstPackage =
true`), netting to zero. It **does** spend one schedule-change unit (a
    move is a move, whether done via reschedule or cancel+rebook).
26. Mechanically: the OLD booking is flipped to `status = rescheduled`
    **before** the new booking is inserted (so an overlapping move — e.g.
    nudging a class 30 minutes — doesn't collide with the very row being
    replaced under the active-only DB constraints), then a NEW booking row is
    created with `rescheduleOfBookingId` pointing at the old one and
    `rescheduleCount = old.rescheduleCount + 1`.
27. The new slot must independently pass the full §13.11 slot generator
    (availability, blocked dates, buffer, advance windows, collisions) — the
    reschedule eligibility check above only governs whether the student may
    _attempt_ a reschedule at all, not whether the target slot is valid.
28. A concurrent double-submit (same booking, or same package's shared
    budget) is guarded by `updateMany`-with-status/budget conditions inside
    the transaction; losing the race reports `slot-conflict`; a package
    deleted out from under the operation reports `package-not-found`
    distinctly (not mis-reported as a slot conflict).

### Auto-completion (`lib/cancellation/auto-complete.ts`, §6.5)

29. Once `scheduledEnd` passes, a still-`scheduled` booking is flipped to
    `completed` by an hourly sweep (`auto-complete-sweep`), not a per-booking
    timer. This transition is quota-neutral under Model B — the class was
    already committed at booking time, so completing it doesn't touch
    `classesUsed` again.
30. The transition is idempotent (`updateMany` guarded on
    `status = scheduled`) — a retried sweep run is a safe no-op.

### Teacher blocking a date range (`lib/cancellation/blocked-date-collision.ts`, §6.1)

31. Creating a `BlockedDate` automatically finds every `scheduled` booking
    whose interval **overlaps** the new blocked range (not just "starts
    inside it" — a class starting before the block but running into it also
    collides) and cancels each one via the standard teacher-cancel path
    (§ rule 19 above): full refund, `Override` row logged with reason
    `"Fecha bloqueada en tu calendario"` (or the teacher's own reason,
    prefixed), and a notification queued that the dispatcher renders as a
    reschedule prompt for the student.
32. Collision cancels are processed in bounded-concurrency batches (5 at a
    time) rather than one at a time, to avoid exhausting the DB connection
    pool on a wide block affecting many classes.

### Availability overrides — scope note

33. There is no separate "one-off addition" primitive layered on top of
    `AvailabilityRule` for a single extra slot outside the recurring weekly
    grid — see Open Questions. The two real override mechanisms in the
    system are: (a) `BlockedDate`, which **removes** availability for a range
    and cascades cancellations (rule 31), and (b) the teacher's self-serve
    booking bypass of her own `minAdvanceH` rule (rule 13), which lets her
    book a slot the generator wouldn't otherwise offer a student, logged via
    the generic `Override` audit table.

## User Flow

### Web — student books a class

1. Student opens `my-classes/book`, sees the teacher's calendar (month/week
   view, `components/calendar/*`) with open slots for their package's class
   length.
2. Student picks a day and slot; server re-validates the full §13.11 chain
   (availability, blocks, buffer, advance window, collisions) against a fresh
   read before writing the booking — the calendar's displayed slots are a
   snapshot, not the authority.
3. On success, redirect to a confirmation page; `booking_confirmation`
   notification queued (push-first, per push-first-default policy).
4. Booking now appears in `my-classes/[bookingId]`, from which the student can
   cancel or (if eligible) reschedule.

### Web — student cancels

1. From `my-classes/[bookingId]`, student submits the cancel form
   (`cancel-form.tsx` → `actions/cancel-booking.ts` → `handleStudentCancel`).
2. Server classifies the timing (`<24h` vs `≥24h`) against `scheduledStart`
   and the server clock, and — for `≥24h` — checks the package's remaining
   schedule-change budget.
3. Outcome is one of: `ok` (with `timing`), `not-found`, `wrong-status`
   (already moved off `scheduled`), or `schedule-changes-exhausted` (budget
   spent — offer to forfeit instead or ask the teacher).
4. On `ok`, the student and teacher each get a notification worded for the
   actual timing/outcome (`cancel_lt24h`, `cancel_gte24h_with_reschedule`,
   teacher mirrors of both).

### Web — student reschedules

1. From `my-classes/[bookingId]/reschedule`, eligibility is checked
   client-visibly (status/budget/24h) before the slot picker is even shown.
2. Student picks a new slot (`reschedule-slot-button.tsx`); server re-runs
   the full eligibility + slot-validity chain and, on success, atomically
   retires the old booking and creates the replacement.
3. Both parties are notified of the change, including the _old_ scheduled
   time for context.

### Web — teacher actions

1. Teacher can self-serve-book on a student's behalf from her own dashboard
   (`actions/teacher-booking.ts`), bypassing her own advance-notice minimum
   only.
2. Teacher can cancel any of her own bookings (`scheduled`, `completed`, or
   `no_show`) with a required reason — refunds the class, logs an `Override`.
3. Teacher can block a date range from her calendar settings; any colliding
   scheduled classes are auto-cancelled and refunded per rule 31.

### Why `next-available-slots.ts` is its own module

`lib/booking/next-available-slots.ts` was split out when the search had an HTTP
caller that could not inline the generator call the way a server-rendered page
can. Nothing needs it to be separate now; it stays because the search is worth
testing without a page around it.

## Data Used

- **AvailabilityRule** — teacher's recurring weekly windows (weekday +
  HH:MM start/end + frozen timezone).
- **BlockedDate** — a one-off range (vacation, sick day, ad hoc block) that
  removes availability and cascades cancellations.
- **Package** — a student's purchased class-credit bundle: `classesTotal`,
  `classesUsed` (committed, not merely completed), `scheduleChangesUsed`
  (pooled move budget spent so far), `classDurationMin`, `expiresAt`.
- **Booking** — one scheduled/rescheduled/cancelled/completed class instance:
  `scheduledStart`/`scheduledEnd`, `status`, `countsAgainstPackage`
  (per-booking quota-commitment flag), `rescheduleOfBookingId` /
  `rescheduleCount`, `bufferMinSnapshot`, `bufferedEnd` (DB-trigger derived).
- **Override** — generic audit log of teacher/admin interventions (cancels,
  self-serve bookings, language overrides, blocked-date cascades) with
  before/after JSON and a reason.
- Google Calendar busy blocks (optional, additive to `BlockedDate`) via
  `lib/calendar/google/*`.

## Edge Cases

- Cancelling a class that has already started: classified `lt24h` (forfeit)
  — there's no separate "in progress" state for cancel purposes.
- Two students racing for the same slot: the DB constraints (not the
  read-time picker) are the actual guarantee; the loser gets a friendly
  "slot taken" error, not a 500.
- Two schedule-changes racing on _different_ bookings in the _same_ package,
  both reading the budget as "available": the second one to commit inside its
  transaction loses the race and is refused, not double-spent.
- A package deleted between a reschedule's eligibility check and its
  transaction: reported distinctly as `package-not-found`, not conflated with
  `slot-conflict`.
- `classesUsed` hitting its floor (0) on a refund path: guarded so it never
  underflows past the DB check constraint; if it would, the cancel/refund
  still completes but the decrement is skipped and logged loudly (an
  already-wrong invariant upstream, not a reason to block the user-facing
  action).
- A teacher lowering her buffer after a booking already exists: the existing
  booking keeps its larger frozen buffer zone; new slot offers respect it,
  never producing an offer the DB would then reject.
- A teacher relocating/changing her profile timezone: existing
  `AvailabilityRule` rows keep generating slots in the zone they were
  written in, not the new one — bookings never silently shift.
- Same-booking double-submit (e.g. a flaky network retry, or two tabs both
  in flight): guarded by conditional `updateMany`s so only the first actually
  mutates state; the second observes "already moved" and is treated as a lost
  race, not a duplicate refund/charge.

## Error States

- `slot-unavailable` / `slot-taken` — booking: the exact slot no longer
  passes generation, or collided at insert time.
- `package-exhausted` — booking: no active package has capacity.
- `package-expired` — booking: capacity exists but every eligible package
  will have lapsed by the class start.
- `not-found` / `wrong-status` — cancel/reschedule: booking doesn't belong to
  the caller's identity set, or already moved off `scheduled`.
- `schedule-changes-exhausted` — cancel (≥24h) / reschedule: the package's
  pooled move budget is spent; the user must forfeit instead or ask the
  teacher.
- `slot-conflict` — reschedule: the new slot collided, or a concurrent
  operation won the race on the same booking/budget.
- `package-not-found` — reschedule: the backing package was deleted mid-flow.
- `booking-not-scheduled` — reschedule eligibility: booking isn't in
  `scheduled` status.
- `lt24h` — reschedule eligibility: less than 24h before class start.

## Permissions

| Action                         | Student (own booking)                                       | Student (other's) | Teacher (own student's booking)                                           | Teacher (other's) | Admin                |
| ------------------------------ | ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | ----------------- | -------------------- |
| View                           | Yes                                                         | No                | Yes                                                                       | No                | Yes (via `/admin`)   |
| Create (book a slot)           | Yes                                                         | —                 | Yes (self-serve, on the student's behalf)                                 | No                | —                    |
| Cancel                         | Yes (subject to 24h/budget rule)                            | No                | Yes (any status in `scheduled`/`completed`/`no_show`, always full refund) | No                | Via override tooling |
| Reschedule                     | Yes (subject to eligibility)                                | No                | Not a distinct teacher action (teacher instead cancels + re-books)        | No                | —                    |
| Block dates (cascades cancels) | No                                                          | No                | Yes (own calendar only)                                                   | No                | —                    |
| Approve                        | N/A — no approval step; a valid slot pick is self-approving |                   |                                                                           |                   |                      |

## Open Questions

- **No documented mechanism to add a single one-off availability slot
  outside the recurring weekly grid.** The system has a way to _remove_
  availability for a range (`BlockedDate`) and a way for the teacher to
  bypass her own advance-notice minimum on a self-serve booking, but no
  distinct "open up this one extra Saturday" primitive was found. If product
  intends teachers to offer one-off extra availability, it isn't modeled
  today — confirm whether this is a real gap or an intentionally out-of-scope
  case (teachers currently just adjust `AvailabilityRule` permanently or use
  the self-serve bypass).
- The exact UI wording/flow for how a student is told _why_ a `≥24h` cancel
  was refused (`schedule-changes-exhausted`) versus simply not showing the
  refund option at all wasn't traced end-to-end into the client component
  copy — confirm the student-facing message matches the "ask your teacher"
  fallback described in the code comments.
- Whether there's a hard cap on how many times a single booking can be
  rescheduled beyond the package-wide pooled budget (i.e., is
  `rescheduleCount` itself ever checked, or purely informational/audit) was
  not found to be enforced anywhere outside the pooled budget check —
  confirm this is intentional (pool is the only cap).
