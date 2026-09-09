# Student Management

## Overview

Student Management covers how a teacher builds and maintains her roster of
students: adding students individually or in bulk, inviting them to create
their own login, keeping private notes on them, and handling changes to a
student's contact details. It also covers "share groups," a student
**acquisition** tool (curating the Facebook/community groups a teacher
posts her booking link in) that is unrelated to sharing a roster between
teachers — there is no teacher-to-teacher roster-sharing feature in the
product today.

A student can be enrolled with more than one teacher; each teacher–student
relationship (roster entry) is independent, with its own pricing overrides,
notes, and archive status, even though the underlying person may be the
same individual across teachers.

## User Stories

- As a teacher, I want to add students to my roster quickly, including
  adding many at once by pasting a list of names/emails, so I don't have to
  create student profiles one at a time.
- As a teacher, I want to invite a student to create their own login (so
  they can book and pay themselves) without that student receiving any
  notifications until I'm ready for them to.
- As a teacher, I want to keep private notes about a student (progress,
  quirks, reminders) that only I can see — never the student, and never
  another teacher.
- As a teacher, I want to update a student's contact details on their
  behalf, and to be protected from silently overwriting a student's own
  verified login email.
- As a student, I want to update my own contact details (name, phone,
  timezone, and — through a verified process — my email) without needing my
  teacher's approval for routine changes.
- As a teacher, I want to keep a running list of the community/Facebook
  groups where I promote my booking link, so I'm reminded to keep posting
  there.
- As a teacher, I want to archive a student who's no longer active without
  deleting their history, and reactivate them later if they come back.

## Business Rules

### Roster & student identity

- A student "roster entry" is a teacher-specific relationship, not a single
  global student record — the same person can appear as separate roster
  entries under different teachers.
- Each roster entry can carry its own custom price override, an assigned
  level (which gates which materials the student can see), free-text
  interests/goals notes (used to help generate class content, kept private
  to the teacher, and excluded from student data exports), and a
  progress-sharing toggle (off by default) controlling whether the student
  can see their own teacher-tracked learning profile.
- A roster entry can be archived by the teacher ("dar de baja") without
  deleting the student or affecting the student's relationship with any
  other teacher. Archiving suppresses ongoing lifecycle notifications for
  that specific teacher–student pairing but does not touch the student's
  existing bookings, packages, or ability to log in.
- A newly created/invited student can be placed on an "onboarding hold,"
  which silences all lifecycle notifications for that pairing until the
  student actually accepts an invitation or self-checks-out — this is how a
  teacher can stage a student in the system before the student knows the
  app exists.

### Adding students in bulk ("CSV import")

- There is no spreadsheet file-upload importer; bulk-adding students is a
  paste-a-list flow that accepts one entry per line, tolerating commas,
  semicolons, tabs, or "Name <email>" formats, and auto-skips a header row.
- Up to 200 entries can be submitted at once; anything beyond that is
  truncated (with a visible "truncated" warning), not silently dropped.
- Each line is validated as containing a plausible email address; rows are
  distinguished as "invalid email" (has an `@` but malformed) vs "missing
  email" (no `@` at all) so the teacher sees a specific reason per row.
- Duplicate handling: the first occurrence of a repeated email in the pasted
  list wins; subsequent repeats are flagged as duplicates within the list.
  Rows are further classified as already-connected (a real login already
  exists for that student) or already-invited (a pending invitation already
  exists) so the teacher only sends new invitations where appropriate.
- **Students added this way receive no notifications by default.** A
  roster entry created via bulk add/import starts with notifications fully
  disabled (every category off). The teacher must explicitly flip a
  "go live" / enable-notifications toggle on that student before the
  student starts receiving any push or email notifications. This is
  intentional so importing a roster doesn't blast unexpected messages to
  people who never opted in. (Full notification-preference behavior is
  documented separately; this is the interaction point with roster import.)

### Student invitations

- An invitation always targets an already-existing roster entry (created
  fresh if needed) — it is the mechanism by which a roster-only student
  gets her own login.
- An invitation expires 30 days after being (re)sent.
- Resending an invitation issues a fresh link (invalidating the old one)
  and resets its expiry; there's a resend cooldown of 60 minutes between
  resends, plus an automatic nudge if the invite still hasn't been used
  roughly 3 days in.
- At most one active (pending) invitation may exist per teacher+email
  combination at a time — trying to invite an already-pending email reuses
  the pending invitation rather than creating a duplicate.
- An email address already used as a teacher's own login cannot be invited
  as a student (accounts are mutually exclusive between teacher and
  student).
- Accepting an invitation requires signing in with the exact email the
  invitation was sent to — a mismatched email is rejected. Acceptance links
  the accepting login to the existing roster entry (it does not create a
  new one) and clears any onboarding hold on that pairing. A second attempt
  to accept an already-accepted invitation from a different account is
  rejected; the same account re-accepting is treated as a harmless no-op.
- If sending the invitation email fails outright, the never-sent invitation
  is discarded rather than left behind as a broken "ghost" invite.

### Per-student notes

- Notes are free-text, private to the teacher who wrote them — never shown
  to the student, and never visible to any other teacher even if the
  student is shared across a class roster in some other sense (there is no
  such sharing mechanism today; see below).
- A note cannot be empty and is capped at 5,000 characters.
- Deleting or editing a note is restricted to the teacher who created it.
- Notes are deliberately kept out of the student-visible class-history audit
  trail, specifically so their contents can never leak to the student.

### Student contact-change handling

- There is no approval queue for contact changes — a change is applied
  immediately and simply recorded in an audit trail (before/after snapshot,
  who made the change: the student themself, the teacher, or a platform
  admin).
- **Email is special-cased**: a teacher may only set/change a student's
  email while that student has never logged in themselves. Once a student
  has a real login tied to their roster entry, the teacher can no longer
  directly overwrite that email — it can only change through the student's
  own verified email-change flow (or an admin support override for
  lost-inbox cases).
- A teacher cannot set a student's email to one already used by another
  student on **her own** roster; the same email existing under a different
  teacher's roster is allowed (rosters are independent).
- A student-initiated email change requires verifying a one-time code sent
  to the _new_ address before it takes effect. Once verified, every roster
  entry that shared the old email is updated together, and a security
  notice is sent to the _old_ address (a heads-up, not a confirmation step
  — the old address cannot block or approve the change).
- Name, phone number, and timezone changes are not email-gated and can be
  made directly by either the student or the teacher, each recorded in the
  audit trail.

### Teacher share groups (student acquisition, not roster sharing)

- A "share group" is simply a teacher's own saved list of the
  Facebook/community groups where she posts her public booking link —
  purely a personal reminder/organizer tool, not a mechanism for sharing
  student data or roster access with anyone.
- Each entry has a name (up to 80 characters) and an optional URL (up to
  300 characters, must be a valid URL if provided).
- These feed a periodic nudge reminding the teacher to keep posting in her
  saved groups; posting itself is always manual/human, nothing is posted on
  the teacher's behalf automatically.

## User Flow

### Adding a single student

1. Teacher opens her student roster and chooses to add a student.
2. Enters at least a name.
3. Student appears on the roster; notifications default according to
   whether the student was invited or just added as a roster-only record.

### Bulk-adding students (web only)

1. Teacher goes to the bulk-invite screen and pastes a list of
   names/emails (one per line, in whatever format is convenient).
2. The system parses the list, flags invalid or duplicate rows, and shows
   which entries are already connected or already invited.
3. Teacher reviews and sends invitations only for the valid, new rows (up
   to the 200-row cap per batch).
4. Newly created roster entries start fully silenced (no notifications)
   until the teacher explicitly enables them per student.

### Inviting a student to get her own login

1. From an existing roster entry (added manually or via bulk import), the
   teacher sends (or resends) an invitation.
2. Student receives an emailed invitation link, valid for 30 days.
3. Student signs in with the matching email and accepts — this links her
   login to the existing roster entry, without creating a duplicate
   student.
4. Once accepted, the "onboarding hold" is lifted for that teacher's
   pairing, so normal lifecycle notifications can resume (subject to the
   student's own preferences).

### Writing a private note

1. Teacher opens a student's detail page.
2. Adds a note (1–5,000 characters) in the notes panel.
3. Note appears in a private, newest-first list; the teacher can edit or
   delete her own notes later. No other party ever sees it.

### Updating contact info

1. Either the student (via her own account page) or the teacher (via the
   roster entry) submits an updated name/phone/timezone/(email, if
   eligible).
2. The change is applied immediately and an audit row is recorded.
3. If it's an email change requested by the student herself, she must first
   verify a one-time code sent to the new address; only then does the email
   actually change, and the old address gets a heads-up notice.

### Archiving a student

1. Teacher opens the student's detail page and chooses to archive
   ("dar de baja"), optionally with a reason.
2. The roster entry is marked archived; future lifecycle notifications for
   that pairing stop. Existing bookings, packages, and login access are
   untouched. The teacher can reactivate later.

## Data Used

- **Student (person)**: name, email, phone, timezone, locale, native
  language, notification preferences, linked login (if any), disabled/
  moderation flags.
- **Roster entry (teacher ↔ student link)**: custom price override,
  assigned level, interests/goals notes, archive status/reason,
  onboarding-hold flag, minor/consent flags, progress-sharing flag.
- **Invitation**: invited email/name, expiry, status (pending/accepted/
  cancelled/expired), send/resend history, who accepted it.
- **Private note**: free-text body, author (teacher), timestamps.
- **Contact-change record**: who made the change, before/after snapshot,
  timestamp.
- **Share group**: name, optional URL, display order — teacher-owned, no
  student data involved.

## Edge Cases

- Same person invited by two different teachers — each teacher gets her own
  independent roster entry; no cross-teacher visibility of the other
  relationship.
- Pasting a bulk list with more than 200 valid rows — excess rows are
  truncated with a visible warning, not silently lost.
- Pasting a list with the same email twice — only the first occurrence is
  treated as valid; the repeat is flagged as a duplicate.
- Re-inviting a student who already has a pending invitation — reuses the
  existing pending invite rather than creating a second one.
- A different person tries to accept an already-accepted invitation — the
  attempt is rejected.
- Teacher tries to set a student's email to one already used elsewhere on
  her own roster — rejected as taken; the same email under a different
  teacher's roster is fine.
- Teacher tries to directly change the email of a student who has already
  logged in — rejected; must go through the student's own verified
  email-change flow.
- Email delivery fails when sending an invitation — the unsent invitation
  is discarded instead of left as a broken pending record.
- Teacher archives a student who has upcoming bookings — bookings are not
  cancelled by archiving; only future notifications for that pairing are
  suppressed.

## Error States

- Bulk-add: malformed email ("invalid_email"), missing email
  ("missing_email"), duplicate within the pasted list, already connected,
  already invited, batch exceeds 200 rows (truncated).
- Invitation: expired token, email mismatch on acceptance, invited email
  belongs to a teacher account, invitation already accepted by someone
  else, resend attempted before the cooldown elapses.
- Notes: empty note body rejected, note body over 5,000 characters
  rejected, attempting to edit/delete a note owned by another teacher
  rejected.
- Contact change: email already taken on the same roster, email change
  attempted directly by a teacher for a student who already has a login
  ("email-locked"), invalid one-time verification code on a student-driven
  email change.
- Share groups: name over 80 characters, URL over 300 characters or not a
  valid URL.

## Permissions

| Action                                          | Owning Teacher                       | Other Teacher | Student (self)                                           | Platform Admin           |
| ----------------------------------------------- | ------------------------------------ | ------------- | -------------------------------------------------------- | ------------------------ |
| View roster entry                               | Yes                                  | No            | N/A (student sees her own account, not the roster entry) | Yes (moderation/support) |
| Add student (single or bulk)                    | Yes                                  | No            | No                                                       | No                       |
| Send/resend/cancel invitation                   | Yes                                  | No            | No                                                       | No                       |
| Accept invitation                               | N/A                                  | N/A           | Yes (matching email only)                                | No                       |
| Create/edit/delete private note                 | Yes (own notes only)                 | No            | No                                                       | No                       |
| Edit student contact info (name/phone/timezone) | Yes                                  | No            | Yes (own)                                                | Yes (support cases)      |
| Edit student email                              | Yes, only if student never logged in | No            | Yes (own, via verified OTP)                              | Yes (support override)   |
| Archive/reactivate roster entry                 | Yes                                  | No            | No                                                       | No                       |
| Manage own share groups                         | Yes                                  | No            | N/A                                                      | No                       |

## Open Questions

- Whether an older, distinct file-upload CSV importer with column mapping
  ever existed prior to the current paste-based bulk-invite flow could not
  be confirmed one way or the other from the current codebase — treat the
  paste/bulk-invite flow described here as the current and only mechanism.
- The exact set of actor types recorded on a contact-change audit row
  (student / teacher / admin) was inferred from usage rather than read
  directly off the enum definition — worth a quick confirmation if exact
  labels are needed for QA test data.
- Per-student private notes and bulk/CSV student import currently have no
  equivalent — single-student invite, contact editing and archiving are all
  present, but bulk import and notes were deliberately kept to one surface by
  design. Confirm this is the intended, permanent product split before
  treating it as a gap to close.
