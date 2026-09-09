# Homework

## Overview

Homework lets a teacher attach a graded assignment to a specific class
(`Booking`) and lets the enrolled student submit an answer (text and/or file
attachments) against it. The teacher can then review the submission and send
the student written feedback with a decision — approve it, ask for a
resubmission, or reject it.

**What is live:** the schema (`Assignment`, `HomeworkSubmission`,
`HomeworkSubmissionFile`, `HomeworkAttempt`, `HomeworkFeedback`); a teacher
surface for listing, creating and deleting assignments; **auto-drafted
assignments** linked back to the `[!homework]`/`[!exercise]` content a teacher
writes into a class's materials, with a notification to the student; a student
submission surface with autosave and file attachments; and **teacher review and
feedback** — reading attempts, writing feedback, and a three-way decision
(approve / request resubmission / reject) with a notification back.

**What is designed but not built**, and is called out again under
[Open Questions](#open-questions) so this document does not overclaim: AI-assisted
review drafts (the `HomeworkAiReviewDraft` table exists but nothing reads or
writes it — there is no "Review with AI" button anywhere), due-soon and overdue
reminders, and audio submissions.

There is also an unrelated, purely cosmetic feature that reuses the word
"homework": a `[!homework]` **Markdown callout style** a teacher can use
inside AI-generated class content. It is just a styled box — it has no
database relationship to `Assignment` and a student cannot submit against it
directly. An assignment _can_ optionally point back at the
material/callout it was drafted from, but the callout itself remains plain
prose.

## User Stories

- As a teacher, I want to attach an assignment to a class so my student knows
  what to do before or after the lesson.
- As a teacher, when I write a `[!homework]` or `[!exercise]` block into a
  class's materials, I want an assignment to appear automatically so I don't
  have to re-type it.
- As a teacher, I want to control late-submission and resubmission policy per
  assignment.
- As a teacher, I want to read what my student submitted and send them
  feedback with a clear decision (approved / needs resubmission / rejected).
- As a teacher, I want to delete an assignment I no longer need.
- As a student, I want to see what homework has been assigned for my class,
  write my answer (autosaved as I type), attach files, and submit it before
  the deadline.
- As a student, I want to keep working on my answer if I lose connectivity,
  without losing my draft.
- As a student, if my teacher asks me to resubmit, I want to be able to edit
  and resubmit my answer.
- As a student, I want to see my teacher's feedback and score once it's
  available.

## Business Rules (exhaustive)

### Assignment

- One assignment always belongs to exactly one `Booking` (class); there is no
  assignment independent of a class and no reusable "template" across
  classes.
- Fields: `title` (required), `instructions` (optional), `dueAt` (optional —
  a null due date means the assignment never becomes "late"),
  `allowLateSubmission` (default **true**), `allowResubmission` (default
  **false**).
- A teacher can **create** and **delete** an assignment. There is **no edit**
  capability today — the server actions expose only create and delete — so a
  teacher who wants to change the title, instructions, due date or policy of an
  existing assignment must delete and recreate it.
- Deleting an assignment cascades to its submissions, attempts, files, and
  feedback; file deletion also best-effort removes the underlying storage
  objects.

### Auto-drafted assignments

- Saving a class's material content (`LibraryMaterial.body`) that contains a
  `[!homework]` or `[!exercise]` callout automatically creates a draft
  `Assignment`, pinned to that exact material revision
  (`sourceMaterialRevisionId`) so a later edit to the material doesn't
  retroactively change what the student was actually assigned.
- This fires **at most once per material** — the system checks for an
  existing assignment linked to that material first, so re-saving the
  content never creates a duplicate.
- Default due date = the student's next scheduled future class with that
  teacher; if no future class is scheduled, the due date is left **empty (no
  default)** — there is no fixed fallback offset.
- The auto-drafted assignment's title is a generic localized "Homework"
  label, not derived from the lesson content — a teacher who wants a more
  specific title has to delete and recreate it manually (no edit exists).
- An auto-drafted assignment is immediately visible to the student the same
  way a manually-created one is — there is no separate "draft, not yet
  published" state; the teacher's only control is to delete it before the
  student notices.
- This process never blocks or fails the underlying materials-save action —
  any internal error in auto-drafting is swallowed and logged.

### Submission

- Exactly one `HomeworkSubmission` row exists per (assignment, student) pair
  — it represents the student's **current state**, not a history. A
  resubmission overwrites this row's content; it does not create a second
  row.
- Submission status: `draft → submitted → returned/graded`. Two additional
  states are shown to users but are computed, not stored: `not_submitted` (no
  submission row yet) and `late` (submitted, and it was submitted after the
  due date).
- A submission is "late" only if it was actually submitted after `dueAt` —
  both values must be set for lateness to apply.
- **Editability**: a `draft` or `returned` submission can always be edited.
  A `submitted` submission can only be edited again if the assignment's
  `allowResubmission` is true. A `graded` submission can never be edited by
  the student.
- **Submitting requires**: the submission must currently be editable, AND
  either the due date hasn't passed, or `allowLateSubmission` is true.
- A submission must contain non-empty text **or** at least one attached file
  — an entirely empty submission is rejected.
- The submission's `submittedAt` timestamp is set on the **first** successful
  submit and preserved through every later resubmission — lateness is always
  judged against the original hand-in time, not the latest resubmission.
- Every successful submit (the original and any resubmission) creates an
  append-only `HomeworkAttempt` snapshot (text + attached files at that
  moment) — this is what gives the teacher a full history to review, even
  though the "current" submission row only ever reflects the latest attempt.
- There is no limit found on the **number** of files per submission — only
  per-file size and type limits (below).

### File attachments

- Maximum file size: **25 MB** per file, verified against the actual
  uploaded object server-side (not the client's claimed size).
- Allowed file types: PDF, Word (`.doc`/`.docx`), JPEG, PNG, and plain text.
  **Audio is not an allowed type today.**
- Files are scoped to the specific teacher/assignment/student, and this
  scoping is re-validated on the server independently of the session check
  that already gates access.

### Teacher review and feedback

- A teacher reviews one **attempt** at a time (not just "the submission") —
  every past resubmission is visible with its own text/files.
- Feedback is written against a specific attempt. Once an attempt has
  feedback, **it cannot be reviewed again** — review is final and
  non-editable per attempt. (A student resubmitting creates a new attempt,
  which can then receive its own new feedback.)
- Feedback consists of: written content (1–5,000 characters, required), an
  optional score from **0 to 10**, and exactly one decision:
  - **Approved** → the submission's overall status becomes `graded`.
  - **Resubmission requested** → the submission's overall status becomes
    `returned`, and the submission becomes editable again for the student —
    this happens regardless of the assignment's `allowResubmission` default;
    an explicit teacher request to resubmit always overrides that flag.
  - **Rejected** → the submission's overall status also becomes `returned`
    (functionally identical to "resubmission requested" at the data level;
    the difference is informational/tone only).
- If a teacher reviews an attempt that is **not** the student's latest attempt
  (e.g. the student resubmitted again before the teacher got to the earlier
  one), the feedback is still recorded, but it does **not** override the
  overall submission status — only feedback on the current latest attempt
  changes what the student sees as their live status.
- Giving feedback fires a best-effort student notification; a notification
  failure never blocks the feedback from being saved.

## User Flow (step by step)

### Teacher — assign homework (manual)

1. Open the class's detail page on the teacher dashboard.
2. Open the Homework panel and click "Add."
3. Enter a title, optional instructions, optional due date, and set the
   late-submission and resubmission toggles.
4. Save — the assignment is immediately visible to the student.

### Teacher — assign homework (auto-draft)

1. Generate or edit a class's AI-produced materials as usual.
2. Include a `[!homework]` or `[!exercise]` block in the content and save.
3. An assignment is created automatically, referencing that exact version of
   the material, and is immediately visible to the student like any other
   assignment.
4. The teacher may delete it (no edit) if it wasn't meant to be assigned.

### Student — submit homework

The student surface is `/my-classes/[bookingId]/homework/[assignmentId]`.

1. Open the class in the student portal; a homework card appears if any
   assignment exists.
2. Open the assignment to reach the submission editor.
3. Type an answer — this autosaves as a draft (roughly every 1.5 seconds).
4. Optionally attach one or more files (PDF/Word/image/text, up to 25 MB
   each).
5. Submit. If the assignment is past due and late submission isn't allowed, or
   the submission is already finalized and resubmission isn't allowed, the
   submit is blocked with a clear reason.
6. Once submitted, the page becomes read-only (unless a later teacher decision
   reopens it).
7. The teacher receives a notification that homework was submitted.

### Teacher — review and give feedback

1. From the class's Homework panel, once at least one student has submitted,
   open Review.
2. See every submitted attempt, newest first, with the student's text and
   files.
3. For an attempt that hasn't been reviewed yet, write feedback, optionally
   assign a score (0–10), and choose Approve / Request resubmission / Reject.
4. Submit the decision — this is final for that attempt and cannot be edited
   afterward.
5. The student is notified that feedback is available.

### Student — see feedback and (optionally) resubmit

1. Open the same assignment screen; a feedback section now appears showing
   the teacher's written feedback and score (if given).
2. If the decision was "resubmission requested" (or "rejected"), the
   submission reopens for editing — the student can revise their answer and
   submit again, creating a new attempt.

## Data Used (business-level entities)

- **Assignment** — the homework brief a teacher creates for a class: title,
  instructions, due date, late/resubmission policy, and (optionally) a link
  back to the source class material it was auto-drafted from.
- **Homework Submission** — a student's current-state answer to one
  assignment: text response, status, and the timestamp they first submitted.
- **Homework Submission File** — a file the student attached, either to the
  current draft or tied to a specific past attempt once submitted.
- **Homework Attempt** — an immutable snapshot of one submit/resubmit event:
  the text and files as they were at that moment, numbered sequentially.
- **Homework Feedback** — the teacher's response to one specific attempt:
  written content, optional score, and a decision (approved / resubmission
  requested / rejected).
- **Homework AI Review Draft** — exists as a data structure only; nothing in
  the product currently creates or consumes it (see Open Questions).

## Edge Cases

- Submitting with no text and no files is rejected outright.
- Submitting after the due date when late submission is disabled is blocked.
- Submitting again when the submission is already finalized and resubmission
  isn't allowed is blocked.
- A teacher reviewing an attempt that already has feedback is blocked — one
  review per attempt, no overwriting.
- A teacher reviewing an attempt that's no longer the student's latest one:
  the feedback is saved, but it does not change what status the student
  currently sees.
- Deleting an assignment with existing submissions removes all of the
  student's submitted work and attempt history for it (via cascade) — this
  is not a soft delete.
- A material edited after an assignment was auto-drafted from it does not
  retroactively change the assignment — the assignment is pinned to the
  original revision.
- A student who never has an upcoming class scheduled gets an auto-drafted
  assignment with no due date at all (not a default deadline).

## Error States

- **Empty submission** — rejected with an explicit "add text or a file"
  error.
- **Past due, late submission disabled** — rejected with an explicit
  "assignment is past due" error.
- **Already submitted, resubmission disabled** — rejected with an explicit
  "submission is locked" error.
- **File too large / wrong type** — rejected before or during upload.
- **File path/ownership mismatch** — rejected server-side even if a client
  somehow constructs a request for it (defense in depth, not something a
  normal user should ever see).
- **Attempt already reviewed** — a second feedback submission on the same
  attempt is rejected.
- **Cross-tenant access** (a teacher or student trying to reach an
  assignment/attempt that isn't theirs) — always presented as "not found,"
  never as a permission error, so the existence of another teacher's/
  student's data is never revealed either way.

## Permissions (view / create / edit / delete / approve / cancel by role)

| Action                                                  | Teacher (owner)                                          | Student (enrolled)                          | Other teacher/student |
| ------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- | --------------------- |
| View assignment                                         | Yes                                                      | Yes, only their own class's assignment      | No (not found)        |
| Create assignment                                       | Yes                                                      | No                                          | No                    |
| Edit assignment                                         | **Not possible for anyone today** (no edit route exists) | —                                           | —                     |
| Delete assignment                                       | Yes                                                      | No                                          | No                    |
| Submit / edit own submission                            | No (not their submission)                                | Yes, subject to the editability rules above | No                    |
| View submission/attempts                                | Yes, for their own students                              | Yes, only their own                         | No                    |
| Give feedback (approve / request resubmission / reject) | Yes, once per attempt                                    | No                                          | No                    |
| View feedback                                           | Yes (their own)                                          | Yes, only their own                         | No                    |

Homework is available on every subscription tier — there is no Pro-only
gating anywhere in this feature today.

## Open Questions

- **AI-assisted review is not built.** The `HomeworkAiReviewDraft`
  database table exists (reserved by the original schema work) but nothing in
  the product reads or writes it — there is no "Review with AI" button, no
  AI-generated draft feedback, and no Pro-gating decision made yet for this
  feature. Any mention of AI-assisted homework review describes a planned,
  not shipped, capability.
- **Due-soon and overdue reminder notifications are not built** — a student is
  never proactively reminded that homework is due soon or overdue.
- **Audio submissions are not built** — despite the product having
  transcription and pronunciation-scoring infrastructure elsewhere, homework
  attachments are limited to PDF/Word/image/text today.
- **Assignment editing does not exist.** A teacher who needs to change a live
  assignment's details must delete and recreate it. Worth confirming whether
  this is acceptable long-term.
- **Feedback score scale**: confirmed as 0–10 in the current implementation,
  but this was an open design question in the source design document at
  the time review and feedback were designed — worth confirming this scale is the
  intended final one before building any analytics/rubric feature on top of
  it.
- **"Approved" vs "Rejected" vs "Resubmission requested"** are functionally
  identical at the data/workflow level except for "approved" locking the
  submission as final — the distinction between "rejected" and "resubmission
  requested" is informational tone only today, with no different follow-up
  behavior. Confirm this is the intended design rather than a placeholder
  for a future distinct "rejected, cannot resubmit" state.
- **The `[!homework]` callout and an `Assignment` remain loosely coupled.** An
  auto-drafted assignment points back at the material revision it came from,
  but the callout itself stays plain prose and a student cannot submit against
  it directly.
