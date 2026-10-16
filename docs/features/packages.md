# Class packages

A **package** is what a student owns: a number of classes of one length with
one teacher, drawn down one class per booking. A teacher sells **package
templates** ("Pack of 10 — 50 min", or a single class); each purchase, or each
package she records by hand, creates one `Package` for one student.

There is no recurring student subscription. A student buys a package, uses it
and buys again; the consumed-package nudge prompts the repurchase.

This document owns the template catalog and a package's balance. Checkout and
money are [payments.md](payments.md); booking, cancelling and rescheduling are
[scheduling-booking.md](scheduling-booking.md).

## Package templates

- A `PackageTemplate` belongs to one teacher: `name`, optional `subject` (free
  text, e.g. "Conversation"), `classCount`, `classDurationMin` (default 50),
  `priceMinorUnits`, `currency`, optional `transferPriceMinorUnits`, and
  `expirationMonths`.
- `currency` is the teacher's own pricing currency (`currencyForTeacher`), set
  when the template is created.
- **Every template needs an expiration in months.** Required by
  `packageTemplateSchema`; the column stays nullable only so legacy rows load.
- **`singleClass` templates** sell one class at a time. `classCount` is forced
  to 1 on the server whatever the form sends. The student picks a slot and pays
  for it in one step; the slot rides on `Package.intendedStartUtc` and the
  auto-book-on-paid job (`lib/booking/auto-book-intended.ts`) books it when the
  payment lands. The in-portal repurchase page (`/my-classes/buy`) has no slot
  picker, so a single class bought there is booked afterwards from the balance.
- **A multi-class package can carry its first class.** The buy page offers the
  same slot picker, optional. Nothing holds the slot before payment, so copy
  must not promise it is reserved; if it is taken or past when the payment
  lands, the credit stays bookable. The remaining classes are booked from the
  student portal after sign-in. A redelivered payment event never books twice:
  the auto-book step looks for an existing booking of that student with that
  teacher at that start time.
- **Non-card price**: `transferPriceMinorUnits` is the price on the Wise rail;
  null means the card price applies there too.
- **Archiving, not deleting.** Removing a template in the editor archives it.
  An archived template stays linked to packages already sold, stops being
  offered, and does not count against the Free cap. The editor never shows
  archived templates, so there is no un-archive control.
- **Free cap**: one active template (`FREE_MAX_PACKAGE_TEMPLATES`); Pro is
  unlimited. The editor submits the whole set at once. A save may keep the
  active count where it is even above the cap (a downgraded teacher keeps every
  template), but may not raise it above the cap. Settings reads the cap from
  `entitlementsFor()` and disables "Add package" at it.

## Packages

- A `Package` belongs to one teacher and one student, and optionally one
  template (`templateId` is nullable, `onDelete: SetNull`).
- **Balance ("Model B")**: `classesTotal` is the size; `classesUsed` counts
  **committed** classes — every booking on the package with
  `countsAgainstPackage = true` (scheduled, completed, no-show, or cancelled
  inside 24 hours). Available to book = `classesTotal − classesUsed`. A booked
  class is spent at booking, so a student cannot book past what she paid for.
  A database check (`packages_classes_used_bounds`) keeps `classesUsed` within
  `0..classesTotal`.
- **Schedule-change budget**: `scheduleChangesUsed`, out of an allowance equal
  to `classesTotal`. Rules in
  [scheduling-booking.md](scheduling-booking.md#the-pooled-schedule-change-budget).
- **Status** (`PackageStatus`):
  - `pending` — checkout started, payment not confirmed. Not bookable.
  - `active` — bookable.
  - `paused` — balance kept, not bookable. Set by the teacher with the pause
    button on the student's Packages tab (`togglePackagePauseAction`), and
    undone the same way.
  - `expired` — past `expiresAt`, or superseded by a newer checkout for the
    same purchase ([payments.md](payments.md#cross-rail-double-charge-guard)).
    Not bookable.
  - `refunded` — the payment was refunded or lost to a chargeback, or an admin
    cancelled the package. The remaining balance is gone.
- **Expiry** is set when the package activates: activation time plus
  `expirationMonths`, end of day in the teacher's timezone
  (`lib/payments/activate-package.ts`). No `expirationMonths` means no expiry.
- **Which package a booking draws from** is decided by the server, never the
  student: the soonest-to-expire eligible credit among the student's active
  packages with that teacher for that class length; packages that never expire
  come last; ties go to the earliest purchase, then id
  (`lib/booking/credit-ledger.ts`). This stops a new top-up being spent while
  an older package expires with classes on it. The student sees one combined
  balance per pool.
- **Pools**: credits are fungible only within one (teacher, class length,
  seats) pool. A 50-minute credit never pays for a 25-minute class.
- A purchase can carry one discount or referral code
  ([referrals-discounts.md](referrals-discounts.md)).

### Packages for two people ([D-149](../decisions/D-149.md))

- A template can also be sold **for two people who take every class
  together**. It then carries `twoPersonPriceMinorUnits` (null = not sold for
  two) and an optional `twoPersonTransferPriceMinorUnits`, which falls back to
  the price for two, never to the one-person transfer price.
- The price for two is **stored**, never derived at checkout. The teacher's
  `twoPersonPricePercent` (100–300, default 150) only suggests it in the
  editor.
- One buyer pays once. The package records `seats = 2`; each class is one
  booking and uses one class. A one-person credit never pays for a class for
  two, or the reverse.
- A grandfathered (agreed) price is a one-person price and never prices a
  package for two.
- The buyer confirms that the second person agrees to the class terms
  (`partnerConsentAt`). Lesson-insights capture for such a class needs that
  confirmation as well as the buyer's consent. A package for two recorded by
  the teacher has none, so its classes are never captured.
- **Selling for two is Pro** (`canSellForTwo`). Only switching it on is gated:
  after a downgrade, prices for two already on sale stay on sale and editable,
  and a teacher can still untick "for two" on a recorded package.
- The booking page shows a "Just me / Two of us" switch only when something is
  sold for two; `?seats=2` opens it on "Two of us".

### Packages the teacher records

From a student's Packages tab a teacher can record a package bought off the
platform (`apps/web/src/app/actions/teacher-packages.ts`):

- She enters the **total** and the **remaining** classes; the app stores
  `classesUsed = total − remaining`, so the credit ledger treats it like a
  bought package. Remaining greater than total is refused.
- No Payment row is written. `pricePaidMinorUnits` is informational: the
  amount she typed, else the linked template's price, else 0.
- A linked template must be hers and only supplies defaults.
- Expiry: a date she types (must be in the future), else the template's
  `expirationMonths` from now, else none.
- The package is created `active`, and an `Override` audit row is written.
- She can **edit** an `active` or `paused` recorded package; remaining classes
  cannot drop below the bookings that already count against it.
- She can **delete** one only if it has no bookings and no payments (a package
  created by mistake); the audit row survives the delete.

## Notifications

- **Expiry nudge**: a daily job emails a student whose active package expires
  within 7 days and still has classes (`package_expiry_nudge`), once per
  package.
- **Consumed nudge**: a daily job tells the student and the teacher when a
  package is fully used and the pair holds no other package that can still be
  booked against (`package_consumed_student`, `package_consumed_teacher`).

## Edge cases

- **A package expires with classes already booked on it.** Expiry gates new
  bookings only; nothing cancels classes already booked. A credit must be
  valid at the class's start time to be drawn, so a booking cannot be made
  past expiry in the first place.
- **A single-class slot is taken before payment lands.** The purchase still
  succeeds; the student holds a one-class credit.
- **A discount drives the price to zero.** Checkout is refused; a free class is
  booked by the teacher directly.
- **A package is refunded after some classes were taught.** Taught classes
  stay as history; the remaining balance cannot be drawn.

## Permissions

| Action                          | Teacher (own)                  | Student (own) | Admin                                      |
| ------------------------------- | ------------------------------ | ------------- | ------------------------------------------ |
| Create, edit, archive templates | Yes                            | No            | No                                         |
| Buy a package                   | —                              | Yes           | No                                         |
| Record, edit, delete a package  | Yes (own students)             | No            | No                                         |
| Pause / resume a package        | Yes                            | No            | No                                         |
| Refund a package's payment      | Yes (Stripe, full refund only) | No            | Yes (finance)                              |
| Cancel a package, extend expiry | No                             | No            | Yes (support), `actions/admin-packages.ts` |
