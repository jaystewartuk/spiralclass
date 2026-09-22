# Feature: Class Packages

## Overview

A **package** is the unit a student actually owns: a bundle of classes with a
given teacher, of a given length, that the student draws down one class at a
time by booking. Teachers don't sell individual class slots on an open
calendar — they sell **package templates** (e.g. "Pack of 10 — 50 min", or a
single pay-per-class offering), and each purchase (or manually recorded
off-platform sale) creates one **package** instance for one student against
one template.

Packages are the bridge between money (`docs/features/payments.md`) and
scheduling: a package holds a class count and an expiry date; a booking
consumes one class from a package and is restored or not depending on
cancellation timing. This document covers the package/template lifecycle
only — the full booking/scheduling rules (buffers, reschedule limits, no-show
handling) live in a separate scheduling doc; this doc describes just enough of
`Booking` to explain how a package's balance moves.

## User Stories

- As a **teacher**, I want to define one or more package offerings (class
  count, duration, price, expiry window) so students can buy a batch of
  classes instead of paying per class.
- As a **teacher**, I want to record a package a student already has (bought
  off-platform, or a mid-cycle balance from before I started using
  SpiralClass) so the app's booking/credit system treats it the same as a
  platform purchase.
- As a **student**, I want to buy a package from my teacher's public booking
  page (or repurchase from inside my portal) and immediately see how many
  classes I have and until when.
- As a **student** with multiple active packages (e.g. a top-up bought before
  my old one ran out), I want my classes booked from whichever package expires
  soonest, so I never lose paid-for classes to expiry while a newer package
  sits untouched.
- As a **teacher**, I want a Free-tier cap on package templates to be a real
  limit that pushes me toward Pro, without ever deleting or breaking a
  template/package I already have.
- As a **teacher**, I want to pause a package (e.g. a student going on leave)
  without losing its balance, and resume it later.

## Business Rules (exhaustive)

### Package Templates (the catalog)

- A `PackageTemplate` belongs to exactly one teacher and defines: `name`,
  optional `subject` (free-text topic label, e.g. "Conversation" or "Business
  Spanish"), `classCount`, `classDurationMin` (default 50), `priceMinorUnits`,
  `currency` (the teacher's chosen pricing currency, default MXN — see D-64),
  an optional `transferPriceMinorUnits` override, and `expirationMonths`.
- **Every template must declare an expiration window in months.** This is
  required at the application/validation layer (not a hard DB constraint, for
  legacy-row compatibility) — a teacher cannot save a template with no
  expiry.
- **`singleClass` templates** are pay-per-class offerings: `classCount` is
  pinned to `1` regardless of what's submitted (a tampered/stale form value
  can't sell "5 single classes" — the class count is force-set server-side).
  The student pays at the moment they reserve a specific time slot, rather
  than buying a balance and booking later.
- **Wise-only pricing override**: a teacher may set a lower price for the
  Wise rail than for Stripe (to pass along the card-processing savings, or
  charge the same). If `transferPriceMinorUnits` is null, the Wise price falls back
  to `priceMinorUnits`.
- Templates can be **archived** rather than deleted. An archived template
  stays attached to any package that already references it (so a purchased
  package keeps its label/history), but no longer appears as a buyable
  option and doesn't count against the Free template cap.
- **Free plan cap**: 1 active (non-archived) package template
  (`FREE_MAX_PACKAGE_TEMPLATES`). Pro is unlimited. The teacher's whole
  desired template set is submitted together from the wizard/settings screen;
  the cap check allows the resulting active count up to the cap and
  **grandfathers** an already-over-cap teacher — they can keep/edit every
  template they already had, but can't add a new one that would push the
  active count higher than it already was. See "Permissions" for exact gate
  behavior.

### Packages (a purchased/recorded instance)

- A `Package` belongs to one teacher, one student, and optionally one
  template (`templateId` is nullable — a manually-recorded package can exist
  without a catalog template, or the template can later be deleted/archived
  without breaking the package via `onDelete: SetNull`).
- Balance accounting ("Model B"): `classesTotal` is the package size;
  `classesUsed` is the count of **committed** classes — every booking on
  this package whose `countsAgainstPackage` flag is true (a scheduled class,
  a completed class, a no-show, or a cancellation inside the &lt;24h penalty
  window). Classes **available to book** = `classesTotal − classesUsed`.
  This is intentionally not "classes completed" — a class that's booked but
  hasn't happened yet already counts against the balance so a student can't
  overbook past what they paid for.
- **Reschedule/cancel budget**: each package separately tracks
  `scheduleChangesUsed` out of an allowance equal to `classesTotal` (one
  pooled "move" per class in the package). A reschedule and a ≥24h
  (refundable) student cancel each consume one unit of this budget. This
  caps churn at the package level, not per booking, so a student can't
  cancel-then-rebook the same class repeatedly to dodge a per-booking limit.
- **Status** (`PackageStatus`): `pending` → `active` → (`paused` ⇄ `active`)
  → `expired` / `refunded`.
  - `pending`: a purchase intent exists (Package + Payment rows created) but
    payment hasn't been confirmed yet. Not bookable.
  - `active`: bookable, counted against expiry.
  - `paused`: balance is preserved but the package is **not bookable** until
    resumed. Reached only via roster import (pre-existing on-hold packages)
    or a teacher dashboard action — never through the live payment funnel.
  - `expired`: past its `expiresAt` date, or superseded by a newer checkout
    for the same purchase intent (see Payments doc — cross-rail
    double-charge guard). Not bookable.
  - `refunded`: money was returned to the student (in full — MVP supports
    full refunds only); the package's remaining balance is revoked.
- **Expiry** (`expiresAt`) is set when the package activates (payment
  confirmed), computed as `purchasedAt + expirationMonths`, **end-of-day in
  the teacher's own timezone**. A template with no `expirationMonths` (only
  possible for legacy rows) produces a package with no expiry.
- **Multi-package credit consumption (the "credit ledger")**: when a student
  has more than one active package with the same teacher for the same class
  length, a new booking is **not** left for the student to choose which
  package to draw from. The server always draws from the credit that expires
  **soonest** among eligible packages (has remaining capacity and is valid at
  booking time); packages that never expire are drawn from last; ties break
  by earliest purchase date, then by id, for determinism. This exists
  specifically to stop a common failure mode: a student picking (or the UI
  defaulting to) the newest top-up, while an older package quietly expires
  with paid-for classes still on it. The student-facing view shows one
  combined balance per (teacher, class duration), not per package.
- Credits are **fungible only within one (teacher, class-duration) pool** — a
  50-minute credit cannot be spent on a 25-minute class.
- A package purchase can carry a **discount code** (promo or per-student
  referral) applied at checkout — the discount reduces the charged amount
  before the Package/Payment rows are created; see Payments doc for the
  checkout pricing stack.

### Recording an off-platform / mid-cycle package

- A teacher can record a package the student already has (e.g. paid in cash
  before the teacher adopted SpiralClass, or a partially-used package
  migrated from another system). The teacher enters the **total** class count
  and how many are **remaining**; the app stores `classesUsed = total −
remaining` so the booking/credit ledger treats it identically to a
  platform-bought package from that point forward.
- **No money moves through the platform for this path** — no Payment row is
  created. The teacher-entered "amount paid" is purely informational
  (`pricePaidMinorUnits`), defaulting to the linked template's price if left
  blank, or `0` if there's no template and no amount entered.
- This is available regardless of payment rail — it's bookkeeping, not a
  charge — and every creation is written to the audit trail (Override log)
  with a before/after snapshot.
- The linked template (if chosen) must belong to the same teacher and is used
  only to default the price/expiry label; the teacher can override every
  field.
- Expiry: an explicit date the teacher types wins; otherwise the linked
  template's `expirationMonths` (if any) is applied from "now"; otherwise no
  expiry is set. An explicit date must be in the future.

### Booking against a package (summary — full detail in the scheduling doc)

- A booking always references exactly one package (`Booking.packageId`); the
  teacher's buffer setting is snapshotted onto the booking at creation time,
  not re-derived from the teacher's current settings.
- `countsAgainstPackage` starts `true` and flips `false` on a ≥24h student
  cancel, a teacher cancel, or a reschedule (the slot's "used" status moves to
  the replacement booking) — these paths give the class back to the balance.
  It stays `true` for a completed class, a no-show, and a &lt;24h student
  cancel (a penalty — the class is forfeited).
- Only `active`-status packages are eligible for new bookings.

### Package expiry notifications

- A scheduled job scans for `active` packages whose `expiresAt` falls within
  an upcoming window and sends the student (and/or teacher) a heads-up nudge
  before the balance is lost to expiry.

## User Flow

**Teacher creates/edits templates:**

1. Teacher opens the package templates screen (onboarding wizard, or
   Settings → Templates later).
2. Teacher adds one or more rows: name, optional subject, class count OR
   marks it as a single/pay-per-class offering, duration, price (+ optional
   Wise override), and a required expiration window in months.
3. Teacher saves. The whole desired set is submitted together; rows can be
   removed ("unkept") — an unselected new row is simply dropped, an
   unselected existing row is archived (not hard-deleted). Removing is
   reversible until she saves: the row collapses to an undo strip and the
   editor counts it among the unsaved changes, so no confirmation dialog
   stands between her and a change nothing has committed yet.
4. If saving would push the number of active templates above the Free cap
   (and the teacher isn't already grandfathered at that count), the save is
   blocked with an upgrade nudge naming the `templates` limit. Settings reads
   the same cap from the entitlements resolver up front and disables "Add
   package" at it, so the refusal arrives before the card is filled in rather
   than after.
5. Saving from Settings → Templates returns the surviving set to the editor
   in place — it does NOT redirect, so her scroll position and open cards
   survive, and a row created in that session picks up its server id. The
   onboarding wizard still redirects, to its next step.

**Student buys a package (public funnel or in-portal repurchase):** see
Payments doc for the full checkout mechanics — the package's `pending` row is
created as part of that flow and flips to `active` when payment clears.

**Teacher records an existing package:**

1. From a student's profile, teacher opens "Add package."
2. Enters total classes, classes remaining, optionally links a template,
   optionally overrides duration/price/expiry.
3. Submits — package is created directly as `active` (no payment step), and
   an audit-log entry is written.

**Student books a class against their balance:**

1. Student picks a time slot on the teacher's calendar.
2. Server resolves which package to draw the credit from using the FIFO-by-
   expiry rule across all their eligible active packages with that teacher/
   duration (transparent to the student — they see one combined balance).
3. Booking is created; the source package's `classesUsed` increments.

**Package reaches its cap or expiry:**

- Once `classesUsed === classesTotal`, no further bookings can draw from it
  (it still exists, just fully consumed).
- Once past `expiresAt`, remaining balance is lost — the package can no
  longer be booked against, even if classes remain.

## Data Used

- **PackageTemplate**: teacher's catalog entry — name, subject, class count,
  single-class flag, duration, price (+ Wise override), currency, expiration
  window, archived flag.
- **Package**: one purchased/recorded instance — teacher, student, optional
  template link, classes total/used, schedule-change budget used, duration,
  price paid, currency, purchase date, expiry date, intended start time (for
  pay-at-reservation single classes), status.
- **Booking**: references a package; carries whether it currently counts
  against that package's balance.
- **Payment**: the money side of a platform purchase (see Payments doc) —
  one-to-many with Package (a package can have more than one Payment row,
  e.g. a superseded/retried checkout).
- **DiscountRedemption / Referral**: at most one per package, records a
  discount/referral applied at purchase time.
- **Override (audit log)**: records manual package creation/edits with
  before/after snapshots.

## Edge Cases

- **Student has two active packages, one expiring next week, one just
  bought.** Every new booking draws from the soon-to-expire one first, even
  though it's the older package, until it's exhausted or expires.
- **A booking is drawn from a package that then expires before the class
  happens.** The booking itself isn't retroactively affected — expiry only
  gates _new_ bookings/consumption, not classes already scheduled against a
  package's balance at the time they were booked. _(Open question below.)_
- **Teacher archives a template that still has active packages against it.**
  The packages are unaffected (their `templateId` stays valid, or is nulled
  out only if the template is hard-deleted, not archived); only the buy flow
  stops offering the template as an option.
- **Teacher is already over the Free template cap** (e.g. downgraded from
  Pro with 5 active templates). They can edit/archive existing templates
  freely and re-save the same count, but any save that would _increase_ the
  active count above the cap is blocked.
- **Single-class (`singleClass`) template with a chosen slot, but someone else
  books that slot before payment clears.** The purchase itself still
  succeeds — the student receives a 1-class credit they can book any open
  slot with — no refund needed, no failure. (Handled by the auto-book-on-paid
  job on the payments side.)
- **Recording a manual package with `classesRemaining` greater than
  `classesTotal`.** Rejected by validation before any row is written.
- **A discount/referral code drives a package's price to zero (e.g. a 100%
  referral).** The checkout is refused outright — see Payments doc; a free
  class must be booked directly by the teacher, not sold as a $0 package.
- **A package is refunded after some of its classes were already booked/
  completed.** The package flips to `refunded` status; already-completed
  classes are historical bookings unaffected retroactively, but the
  package's remaining balance can no longer be drawn against.

## Error States

- **Saving a template set with no expiration entered on a kept row** —
  blocked with a stable "expiration required" validation error.
- **Saving a template set that would exceed the Free template cap** — blocked
  with an upgrade-to-Pro message naming the `templates` limit; existing
  templates are never touched.
- **Recording a manual package for a student not on the teacher's roster** —
  rejected ("this student isn't in your list").
- **Recording a manual package with an expiry date in the past** — rejected.
- **Recording a manual package where `classesRemaining > classesTotal`** —
  rejected with a field-level error.
- **Booking against a `pending`, `paused`, `expired`, or `refunded` package**
  — refused (only `active` packages are bookable); full error surface lives
  in the scheduling doc.

## Permissions

| Action                               | Teacher (own)               | Teacher (other) | Student (own) | Student (other) | Admin                         |
| ------------------------------------ | --------------------------- | --------------- | ------------- | --------------- | ----------------------------- |
| View own templates                   | Yes                         | No              | N/A           | N/A             | Yes (read-only, cross-tenant) |
| Create/edit template                 | Yes                         | No              | No            | No              | No                            |
| Archive template                     | Yes                         | No              | No            | No              | No                            |
| Delete template (hard)               | Not exposed — archive only  | —               | —             | —               | —                             |
| View own package balance             | Yes (as the seller)         | No              | Yes           | No              | Yes                           |
| Purchase a package                   | N/A (students buy)          | N/A             | Yes (self)    | No              | No                            |
| Record a manual/off-platform package | Yes (own students)          | No              | No            | No              | No                            |
| Pause/resume a package               | Yes (own students)          | No              | No            | No              | No                            |
| Refund a package's payment           | Yes (own, full refund only) | No              | No            | No              | Yes (support tooling)         |

## Open Questions

- **Does a booking already drawn from a package survive that package's later
  expiry, or does an expired package's future-dated bookings get cancelled
  retroactively?** The code snapshots consumption at booking time and gates
  _new_ bookings on `active` status, but no code path was found that cancels
  already-scheduled future bookings when their source package crosses its
  `expiresAt`. Treating this as "expiry only blocks new draws" until
  confirmed otherwise.
- **Can a teacher un-archive a template**, or is archiving one-way? No
  restore action was found in the reviewed code.
- **Is there a UI path to pause/resume a package outside of roster import?**
  The schema/comments describe a teacher-dashboard action but the exact
  screen wasn't reviewed in this pass — confirm before writing QA steps for
  it.
- **What happens to a package's remaining schedule-change (`scheduleChangesUsed`)
  budget on refund or expiry?** Not explicitly reset or forfeited in what was
  reviewed; assume it simply becomes moot once the package can no longer be
  acted on.
