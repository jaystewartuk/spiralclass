# Student management

How a teacher builds and keeps her roster: adding students, inviting them to
their own login, private notes, contact details, archiving and merging
duplicates. The roster lives at `/dashboard/students`.

How one person studying with several teachers is modelled:
[docs/architecture/multi-teacher-students.md](../architecture/multi-teacher-students.md).
How a student signs in and gets linked to her roster row:
[authentication.md](authentication.md). Where a teacher lists the communities
she posts in: [student-acquisition.md](student-acquisition.md).

## The roster

- A roster entry is a `TeacherStudent` pairing. The same person under two
  teachers has two independent entries, each with its own custom price, level,
  notes, archive state and settings.
- An entry carries: a custom price override (Pro), an assigned level (which
  decides the library materials she sees), interests and goals notes (used for
  class content, private to the teacher, excluded from the student's data
  export), and a progress-sharing toggle (off by default) for her learning
  profile.
- **Archiving** ("dar de baja", `toggleStudentArchive`) parks the pairing:
  lifecycle notifications for it stop, and the portal stops offering this
  teacher's packages. Bookings, packages, her login and her other teachers are
  untouched. The teacher can reactivate.
- **Onboarding hold.** A student the teacher adds by hand
  (`createStudentAction`) or invites starts on an onboarding hold, which the
  teacher lifts with **Go live** (`setStudentLiveAction`, audited). What it
  suppresses and what else clears it:
  [notifications.md](notifications.md#new-students-and-the-onboarding-hold).
- Separately, the teacher can switch a student's notification categories all
  off or back to default from the student's page
  (`lib/students/notification-toggle.ts`).
- **Duplicates** (usually a checkout email typo) can be merged
  (`mergeRosterStudents`, `lib/students/merge.ts`): packages, bookings,
  assignments, notes and history move to the kept row and the duplicate is
  deleted. Refused when the duplicate belongs to another teacher, when both
  rows have different logins, when either is under moderation, or when the
  duplicate has a pending deletion request.
- A student an operator marked as a **test account**
  ([admin-portal.md](admin-portal.md#test-accounts)) stays on the roster with a
  badge but counts in none of the roster's figures. In a test teacher's own
  roster everyone counts.

## Invitations (`lib/invitations/`)

An invitation is how a roster-only student gets her own login. Constants are
in `lib/invitations/constants.ts`.

- **Bulk invite** (`/dashboard/students/invitations/new`): she pastes a list, one
  entry per line; commas, semicolons, tabs and `Name <email>` are accepted and
  a header row is skipped. At most `INVITATION_BULK_MAX` (200) rows per batch;
  extra rows are cut with a visible warning.
- Each row is classified: `invalid_email` (has an `@` but malformed),
  `missing_email`, duplicate within the list (first wins), already connected
  (has a login), already invited (pending invitation). Invitations go only to
  the valid, new rows.
- An invitation targets a roster entry, creating the student (on onboarding
  hold) if needed. One pending invitation per teacher and email; re-inviting
  reuses it.
- It expires `INVITATION_TTL_DAYS` (30) after it is sent or resent. Resending
  issues a new link and is limited by `INVITATION_RESEND_COOLDOWN_MINUTES`.
- A daily job emails the **teacher** one digest of invitations still pending
  after `INVITATION_NUDGE_AFTER_DAYS` (3), once per invitation
  (`lib/invitations/nudge.ts`).
- The link carries a random 256-bit token; only its SHA-256 hash is stored
  (`lib/invitations/token.ts`). Copying the link from the dashboard rotates the
  token, so earlier emailed links stop working.
- The email is sent directly, not through the notification dispatcher, because
  the recipient is not a user yet. If the send fails, the invitation is
  discarded.
- An email that is a teacher's login cannot be invited as a student.
- **Accepting** requires signing in with the invited email; a mismatch is
  refused. Acceptance links the login to the existing roster entry (no new
  student) and clears the onboarding hold. An invitation accepted by another
  identity is refused; the same identity accepting again is a no-op.

## Private notes

- A dated journal (`StudentNote`, many per pairing, newest first), free on
  every plan. Each note is 1–5,000 characters.
- Only the teacher who wrote a note can see, edit or delete it. Notes never
  appear in the student-visible class history: edits are not written to
  `overrides`, and analytics carry ids, never the body.
- Notes are in the teacher's data export and never in the student's. Erasing a
  student deletes them; a merge moves them to the kept row.

## Contact details (`actions/student-contact.ts`)

- No approval queue: a change applies at once and is recorded in
  `StudentContactChange` (before/after, actor `student`, `teacher` or
  `admin`).
- **Email**: a teacher may set or change a student's email only while the
  student has never signed in (otherwise `email-locked`), and not to an email
  already on her own roster. The student changes her own email by verifying a
  one-time code sent to the **new** address; every roster row that shared the
  old email is updated together, and the old address gets a security notice
  (informational — it cannot block the change). An admin can override for a
  lost inbox.
- **Name, phone and timezone** can be changed by the student (account page) or
  the teacher (the student's contact card), each audited.

### The student's timezone

- It decides the clock her portal and emails show class times in; with none
  saved they use the teacher's. It never moves a class: bookings are fixed
  moments. Slots are still generated in the zone the teacher's hours were
  written in ([D-53](../decisions/D-53.md)).
- It is filled from her device the first time she opens the portal, and that
  capture never overwrites a saved zone.
- When her device's clock differs from the saved zone (compared by the clock
  shown, not the zone name), every portal page offers "Use <device city> time"
  or "Keep <saved city> time" (`switchMyTimezoneAction`). Keeping is
  remembered in that browser for that pair of zones.
- She can also change it on her account page, and her teacher from the contact
  card.

## Error states

- Bulk invite: `invalid_email`, `missing_email`, duplicate, already
  connected, already invited, truncated batch.
- Invitation: expired, email mismatch, email belongs to a teacher, accepted by
  someone else, resend inside the cooldown.
- Notes: empty, over 5,000 characters, not the author.
- Contact: email taken on this roster, `email-locked`, wrong verification
  code.

## Permissions

| Action                                   | Owning teacher                | Student (self)        | Admin                                 |
| ---------------------------------------- | ----------------------------- | --------------------- | ------------------------------------- |
| View the roster entry                    | Yes                           | No (sees her account) | Yes (support)                         |
| Add students, send/resend/cancel invites | Yes                           | No                    | No                                    |
| Accept an invitation                     | —                             | Yes (matching email)  | No                                    |
| Notes                                    | Yes (own notes)               | No                    | No                                    |
| Edit name, phone, timezone               | Yes                           | Yes                   | No                                    |
| Edit email                               | Only before her first sign-in | Yes (verified code)   | Yes (`adminChangeStudentEmailAction`) |
| Archive, go live, merge                  | Yes                           | No                    | No                                    |
