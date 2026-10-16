# Account Settings

Teachers and students each have a self-service settings area: profile, sign-in
email, notification preferences, reading and language preferences, a data
export and account deletion. Both pages use the same email-change form,
deletion form and export endpoint; they differ in the profile fields and the
teaching- or learning-specific options.

| Role    | Page                  | Notification preferences  | Calendar feed        |
| ------- | --------------------- | ------------------------- | -------------------- |
| Teacher | `/settings/account`   | `/settings/notifications` | `/settings/calendar` |
| Student | `/my-classes/account` | on the account page       | on the account page  |

## Business rules

### Profile

- Both roles: name, phone number, timezone.
- **Teacher**: country, plus a "classes" section with the auto-surface
  at-their-level materials toggle and, when recording is enabled
  (`recordingEnabled()`), the auto-record toggle
  ([live calls](live-calls-video.md#recording)). Booking-page content
  (headline, bio, photo, intro video, WhatsApp number) lives on
  `/settings/booking-page`.
- **The teacher's country locks once she has a Stripe Connect account**
  (`teacher.stripeAccountId` set): Stripe fixes a connected account's country
  at creation, so changing ours would desync from Stripe.
  `updateMyTeacherCountryAction` refuses it; a Wise-only teacher can still
  change it.
- The booking-page WhatsApp number is a separate, opt-in public field shown as
  a "Chat on WhatsApp" button on `/b/<slug>`; the account phone stays private.
  Neither is used for automated messaging — both only ever open a plain
  `wa.me` link ([notifications](notifications.md#channels)).
- **Student**: profile photo, native language, captions consent
  ([live calls](live-calls-video.md#live-captions)), an install-the-app row.

### Interface language and reading

- Both roles pick an interface language from the locale registry, or
  **System Default**, which follows the browser language. The choice is stored
  in the `locale` cookie; when signed in, the resolved locale is mirrored onto
  the account row so emails and pushes use it (`setLocaleAction`,
  `app/actions/locale.ts`).
- Reading preferences: text scale (`READING_SCALES`: 1, 1.125, 1.25), three
  spacing steps (letter, word and line spacing together), and a warm tint
  (`lib/reading.ts`, [D-140](../decisions/D-140.md)). Stored on the account and
  mirrored into a cookie so they apply on first paint and follow the person
  between devices. Teachers meet them as the first onboarding step.

### Sign-in email change

- Two steps, same for both roles: request a change (a 6-digit code goes to the
  **new** address), then enter the code.
- Only the new address confirms. Once the change lands, a security notice (not
  a confirmation) goes to the **old** address (`sendEmailChangedNotice`,
  `lib/account/email-change-mail.ts`).
- The change disconnects any linked Google account and signs out every other
  session — see [authentication](authentication.md#changing-the-sign-in-email).
- `?correo=actualizado` is still read so that old link-based confirmation
  emails land somewhere sensible; new changes are code-only.

### Notification preferences

- Per category: an on/off toggle and the channels to use (push and/or email).
  The form will not let the last channel of an enabled category be unticked; a
  category with no stored channel list uses every channel.
- Global email and push opt-in toggles sit beside the categories. The push
  toggle is disabled when the account has no registered browser.
- Category lists, non-suppressible notices and the defaults for a new student
  are owned by [notifications](notifications.md#categories-and-preferences).
- The student page also shows when reminders will arrive
  (`NotificationSchedule`).

### Calendar feed

- Both roles have a private, regenerable calendar feed link
  (`calendarFeedToken`) for subscribing an external calendar app — the teacher
  on `/settings/calendar`, the student on her account page.
- Both pages can also link a Google account for sign-in.

### Data export

- One click, both roles: `GET /api/account/export` returns a JSON file of the
  caller's own data as a download (never emailed). It takes no parameters — you
  can only export yourself.
- A disabled account (moderated, or deleted) gets `403 account-disabled`.
- Teacher export (`buildTeacherExport`, `lib/account-deletion/export-data.ts`):
  profile, booking configuration, payment-rail identifiers (never secrets),
  package templates, roster links with her own private notes about each student
  (by student id, not other people's contact details), packages, payments and
  bookings.
- Student export (`buildStudentIdentityExport`): profile, consent flags, linked
  teachers, her own packages, payments and bookings — across every student row
  that shares her email (`studentComplianceIds`), not just one.

### Account deletion

- Self-service request with a **30-day grace period**
  (`DELETION_GRACE_PERIOD_MS`, `lib/account-deletion/requests.ts`), cancellable
  any time while pending.
- **Refused at request time** while any relevant package is active with classes
  left to use (`classesUsed < classesTotal`) — the teacher's packages, or the
  student's.
- At most one pending request per subject (a partial unique index;
  re-requesting is a no-op). A student's request is filed against every
  student row sharing her email.
- A daily job (`account-deletion-cron`, 04:00 UTC) processes matured requests:
  - It **claims** each row (`pending` → `anonymizing`) before any destructive
    work, so a cancel that lands first wins and the row is skipped.
  - It re-checks for unused paid classes (one may have been sold during the
    grace window). If any exist the request goes back to `pending` with
    `scheduledFor` pushed out 7 days (`DELETION_DEFER_MS`) and a warning is
    logged for ops.
  - Any error releases the claim back to `pending` for the next day's run.
- **Teacher, on completion:** a live Stripe subscription (active, trialing or
  past due, not comped) is cancelled at period end first; Stripe 400/404
  ("already cancelled or missing") counts as done, any other failure aborts so
  the run retries. Then her email becomes `deleted+<id>@spiralclass.invalid`,
  the name a placeholder, phone and payment-rail fields are cleared, and the
  account is disabled with reason `account_deleted`. Her recordings, lesson
  audio, transcripts and summaries are then purged — stored files first, then
  rows; a row whose file could not be deleted is kept and logged, and nothing
  retries it (`lib/account-deletion/purge-recordings.ts`,
  [D-22](../decisions/D-22.md)). A purge failure never blocks the deletion.
- **Student, on completion:** the same tombstoning; `authUserId` is cleared so a
  re-sign-in cannot rejoin the row; her contact-change history and her
  teachers' private notes about her are deleted outright. A student's deletion
  purges no recordings — they belong to the teacher's account.
- **Both:** web push subscriptions and notifications addressed to the account
  are deleted, and every live session is revoked.
- The better-auth `user` identity row is **not** deleted by the job; an
  operator removes it by hand.

Request statuses (`AccountDeletionStatus`): `pending`, `anonymizing`,
`cancelled`, `anonymized`. A deferred request is simply `pending` again with a
later `scheduledFor`.

## Error states

- Export refused: account disabled (403) or no session (401).
- Deletion refused: unused paid classes outstanding.
- Email change: wrong or expired code.
- Country change refused: a Stripe Connect account exists.

## Permissions

Every action here is self-service and scoped to the caller's own account.
Staff tools for disabling accounts, changing a student's email on her behalf,
and removing a deleted account's identity row are in the
[admin portal](admin-portal.md).
