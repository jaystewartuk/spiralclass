# Account Settings

## Overview

Both teachers and students have a personal account settings area covering
their profile details, sign-in email, notification preferences, exporting
their own data, and deleting their account. The two roles' settings pages
share most of the same underlying building blocks (same email-change flow,
same data-export/delete component) but differ in which profile fields and
teaching/learning-specific options they expose, since a teacher's settings
also include business configuration (country, pricing currency lock, booking
page) while a student's include things like native language and calendar
sync.

## User Stories

- As a teacher, I want to update my name, phone, and timezone without
  affecting my sign-in email.
- As a teacher or student, I want to change my sign-in email safely, with
  confirmation that it's really me and a notice sent to my old address.
- As a teacher or student, I want to control which notifications I receive
  and through which channel (push vs. email), per category.
- As a teacher or student, I want to download a copy of my own data.
- As a teacher or student, I want to delete my account, understanding that
  there's a grace period and that I can cancel the deletion if I change my
  mind.
- As a teacher, I want my country and pricing currency to be protected from
  accidental changes once I've started getting paid, since changing them
  after the fact could break payouts.
- As a student, I want to set my native language and sync my classes to my
  own calendar.

## Business Rules

**Profile details**

- Shared fields for both roles: name, phone number, timezone.
- Teacher-only: country (locked/unchangeable once the teacher has connected
  a payment rail — this protects payout configuration from being silently
  broken), booking-page headline/bio/photo/intro video/WhatsApp number
  (managed on a separate booking-page settings screen, not the main account
  page). The booking-page WhatsApp number is a separate opt-in field from
  the account phone above — it's shown publicly on `/b/<slug>` as a "Chat on
  WhatsApp" button, while the account phone stays private (see D-42).
- Student-only: profile photo, native (learning) language.

**Sign-in email change**

- Same two-step flow for both roles: request a change (sends a verification
  code to the **new** address), then verify with that code to complete the
  change.
- Only one confirmation is required — from the new address. A security
  notice (not a second confirmation) is sent to the **old** address once the
  change has completed, so the previous owner is informed even though they
  don't have to approve it.
- A legacy link-based confirmation path (`?correo=actualizado`) still exists
  purely to avoid breaking old, already-sent email links from before the
  code-only cutover; new email-change confirmations are code-only.

**Notification preferences**

- Both roles get a per-category on/off toggle plus a per-category choice of
  delivery channel (push and/or email) — at least one channel must remain
  selected per enabled category (can't switch a category "on" with zero
  channels).
- Teacher categories: class activity, student progress, subscription/
  billing-related updates, and platform "growth" updates.
- Student categories: class reminders, booking updates, class materials,
  package/expiry reminders, and messages.
- A separate, global pair of toggles (email opt-in / push opt-in) exists
  independent of the per-category settings; the push toggle is disabled if
  the account has no registered device to push to.
- Certain categories — payments, security, and billing notices — are
  **non-suppressible**: they always send regardless of any of the above
  preferences. This is called out explicitly in the settings UI.
- Students additionally see a notification-schedule/quiet-hours display not
  present for teachers.
- A student added via CSV import/manual roster entry starts with **all**
  notification categories switched off, since they never opted in
  themselves; they can turn any of them on afterward.

**Calendar sync**

- Student-only feature: a private, unique calendar feed link (for
  subscribing an external calendar app to their class schedule). Not
  present on the teacher side of account settings (teachers have separate
  calendar-sync settings elsewhere in the product).

**Data export**

- Available to both roles, self-service, one click, produces a downloadable
  file (not emailed) containing only that person's own data.
- A disabled account (e.g., mid-deletion, or moderated) cannot use export.
- Teacher export includes: profile, booking configuration, payment-rail
  identifiers (account/reference IDs only — never secrets/credentials),
  package templates, roster links (including the teacher's own private
  notes, interests, goals, and custom pricing notes about each student, by
  student ID rather than exposing other people's contact details), packages
  and payments, and bookings.
- Student export includes: profile, consent flags, which teacher(s) they're
  linked to, their own packages/payments, and their own bookings. If the
  same person has multiple student records across different teachers
  sharing the same email, the export covers that whole set, not just one
  record.
- Exports are deliberately scoped so that a teacher's export never leaks
  another person's private contact information, and a student's export only
  ever contains their own copy of shared data.

**Account deletion**

- Self-service request, both roles, with a **30-day grace period** before
  anything is actually removed.
- **Blocked at request time** if the account has any active package with
  classes already paid for but not yet used — you cannot request deletion
  while you (or your students, for a teacher) still have unused, paid
  classes outstanding.
- Only one pending deletion request can exist at a time per account; filing
  a second request while one is already pending doesn't create a duplicate.
- **Cancellable at any point** while the request is still pending (i.e.,
  anytime within the 30-day window before it takes effect).
- For a student who has the same email linked across multiple teachers'
  rosters, deletion is filed against the **whole set** of that person's
  student records, not just one.
- **At the 30-day maturity point**, the system re-checks for unused, paid
  packages (in case one was purchased during the waiting period). If any
  exist, the deletion is **deferred, not cancelled** — pushed back by an
  additional 7 days and flagged for staff attention, rather than silently
  proceeding or silently failing.
- **What actually happens on completion:**
  - Teacher: email is replaced with a non-deliverable placeholder, name
    replaced with a generic "deleted account" label, phone and
    payment-rail details cleared, the account marked disabled with reason
    "account deleted." Any live subscription billing is cancelled first
    (already-cancelled/missing billing is treated as a successful no-op;
    a genuine billing-system failure stops the process so it can be
    retried rather than completing a broken deletion).
  - Student: similarly anonymized/tombstoned; the link back to the
    sign-in identity is severed; any stored contact-change history and
    private teacher notes about that student (both of which can carry
    personal information or free-text detail) are permanently and
    completely removed, not just anonymized.
  - Both roles: registered devices (for push notifications) and pending
    notifications are removed; any live signed-in sessions for that
    account are force-signed-out.
  - The underlying sign-in identity record itself is **not** automatically
    deleted by this process — a final manual step by platform staff is
    required to remove it completely. This is by design, not a bug.

## User Flow

**Editing profile details**

1. Open account settings (`/settings/account` for a teacher, `/my-classes/
account` for a student).
2. Edit name/phone/timezone (and role-specific fields) and save.

**Changing sign-in email**

1. Open the email-change form, enter the new email.
2. Receive and enter a verification code sent to the new address.
3. Email is updated; a notice is sent to the old address.

**Adjusting notification preferences**

1. Open the notifications section of account settings.
2. Toggle categories on/off and choose channel(s) per category, or adjust
   the global email/push opt-in toggles.
3. Changes save immediately/on submit.

**Exporting data**

1. Open the data-export section.
2. Request export; a file download begins immediately (role-appropriate
   content, scoped to the requester only).

**Deleting an account**

1. Open the delete-account section; confirm intent.
2. If there are unused, paid-for classes outstanding, the request is
   blocked with an explanation.
3. Otherwise, a deletion request is filed with a 30-day grace period.
4. At any point before maturity, the person can return to this section and
   cancel the pending request.
5. If not cancelled, and no new unused paid packages appeared, the account
   is anonymized/disabled once the 30 days elapse. If a new unused package
   did appear, the deletion is pushed back by 7 more days instead of
   proceeding.

## Data Used

- **Profile**: name, phone, timezone, and role-specific fields (teacher:
  country, pricing currency, booking-page content; student: photo, native
  language).
- **Sign-in email** and its verification status.
- **Notification preferences**: per-category on/off + channel choice, plus
  global email/push opt-in flags.
- **Calendar feed token** (student-only): a private link used to subscribe
  an external calendar.
- **Export file**: a point-in-time snapshot of the requester's own account,
  packaged as a downloadable file.
- **Deletion request**: status (pending/cancelled/deferred/completed), when
  it was filed, when it's scheduled to take effect.

## Edge Cases

- A teacher tries to change their country after already connecting a
  payment rail — blocked; country is a one-way-locked field at that point.
- A student's account has the same email across two different teachers —
  both notification preferences and export operate per student record, but
  export bundles the whole set; deletion also fans out to the whole set.
- Someone requests deletion while they (or their students, if a teacher)
  still have paid, unused classes — blocked with an explanation rather than
  silently ignored.
- A new unused package appears during the 30-day deletion grace period
  (e.g., someone else bought a package on the student's behalf, or the
  teacher sold a new package before the window closed) — the deletion is
  automatically deferred by 7 days and flagged, not silently completed or
  silently dropped.
- Two people (or two processes) try to act on the same deletion request at
  once (e.g., a cancel arriving just as the scheduled anonymization job
  starts) — the anonymization job claims the request atomically first, so a
  concurrent cancel can't be silently overwritten mid-process, and a request
  that was cancelled just before the job scanned it is correctly skipped.
- A billing cancellation fails with a genuine server error (5xx) during
  deletion — the whole deletion step is retried later rather than completing
  a partial deletion with billing still live; a "no billing to cancel" or
  "already cancelled" response is treated as fine and deletion proceeds.
- An account is disabled/moderated when someone tries to use export — export
  is refused.
- The push-notification toggle is turned on for an account with no
  registered device — the control is shown disabled, since there's nothing
  to push to yet.

## Error States

- Export blocked — account is disabled or mid-deletion.
- Deletion request blocked — unused, paid-for classes still outstanding.
- Deletion deferred at maturity — unused package appeared during the grace
  window; pushed back 7 days, flagged for staff.
- Email-change verification failure — wrong/expired code entered while
  confirming a new email address.
- Billing cancellation failure during deletion (server error) — deletion
  paused/retried rather than completed.
- Notification save rejected — attempting to disable the last remaining
  delivery channel for an enabled category.

## Permissions

- **Teacher**: can view/edit only their own profile, email, notification
  preferences, export, and deletion request. Cannot view or act on another
  teacher's or any student's account settings.
- **Student**: can view/edit only their own profile, email, notification
  preferences, export, and deletion request (per student record they own).
  Cannot view or act on a teacher's settings or another student's account.
- **Staff/Admin**: has separate administrative tools to view/manage
  teacher and student accounts (e.g., disabling accounts, handling disputes)
  outside of this self-service settings surface; the final, manual removal
  of an underlying sign-in identity after a completed deletion is a
  staff-only step, not exposed to the account holder.
- No role can approve or override someone else's own account-settings
  changes — these are entirely self-service, aside from the staff/admin
  capabilities noted above.

## Open Questions

- Whether there is a user-facing way (beyond a support/staff action) to
  fully remove the underlying sign-in identity row after account deletion
  completes was not found in the self-service flow — this appears to be an
  intentional manual operator step, but the exact runbook trigger for it
  was not verified in this pass.
- Whether teachers have any equivalent of the student's calendar-sync
  feature within the main account-settings page (as opposed to a separate
  settings area) was not fully resolved — teacher calendar sync appears to
  live outside `/settings/account` entirely, but its exact location and
  behavior weren't audited as part of this account-settings review.
- Whether an "Appearance" (light/dark/system theme) preference belongs in
  account settings at all, now that the app that had one is gone, is not stated
  anywhere in the code.
