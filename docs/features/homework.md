# Homework

A teacher attaches an assignment to a class (`Booking`); the student answers it
with text and/or files; the teacher reviews each attempt and sends feedback
with a decision — approve, request resubmission, or reject. A teacher on Pro
can also ask Claude for a draft review first.

Tables: `Assignment`, `HomeworkSubmission`, `HomeworkSubmissionFile`,
`HomeworkAttempt`, `HomeworkFeedback`, `HomeworkAiReviewDraft`. Code:
`lib/homework/`, `app/actions/homework.ts`, `app/actions/homework-submission.ts`.

Homework is free on every plan; only **Review with AI** is Pro.

The `[!homework]` Markdown callout is a styled box in class content. It is not
an assignment and a student cannot submit against it — but saving content that
contains one auto-drafts a real assignment (below).

## Assignment

- Belongs to exactly one booking; there are no reusable assignment templates.
- Fields: `title` (required, ≤ 200 characters), `instructions` (optional,
  ≤ 5,000), `dueAt` (optional — null never becomes late), `allowLateSubmission`
  (default **true**), `allowResubmission` (default **false**).
- A teacher can **create** and **delete**. There is **no edit**: to change one,
  delete and recreate it.
- Deleting cascades to submissions, attempts, files and feedback, and
  best-effort deletes the stored files.

## Auto-drafted assignments

- Saving a class's content (`LibraryMaterial.body`) that contains a
  `[!homework]` or `[!exercise]` callout creates an `Assignment` pinned to that
  material and revision (`sourceMaterialId`, `sourceMaterialRevisionId`), so a
  later edit does not change what was assigned (`lib/homework/auto-draft.ts`).
- **At most once per material**: an assignment already linked to the material
  means nothing is created.
- `dueAt` is the start of the student's next scheduled class with that teacher,
  or empty if there is none.
- The title is the generic localized "Homework" label.
- It is visible to the student at once, like a manual one, and the student is
  notified (a manually created assignment sends no notification). There is no draft state; the teacher's control is to delete it.
- Errors are logged and swallowed; they never fail the content save.

## Submission

- One `HomeworkSubmission` per (assignment, student) — the current state, not a
  history. A resubmission overwrites it.
- Stored status: `draft` → `submitted` → `returned` / `graded`. Shown but not
  stored: `not_submitted` (no row) and `late` (submitted after `dueAt`).
- **Editable** when `draft` or `returned`; when `submitted` only if
  `allowResubmission`; never when `graded`.
- **Submitting needs** an editable submission, and either a due date not yet
  passed or `allowLateSubmission`.
- Text or at least one file is required.
- `submittedAt` is set on the **first** submit and kept, so lateness is judged
  against the original hand-in.
- Every submit creates an append-only `HomeworkAttempt` snapshot of the text and
  files — the teacher's history to review.
- The answer autosaves as a draft while she types.

### Files

- ≤ **25 MB** each (`MAX_SUBMISSION_FILE_BYTES`), checked against the uploaded
  object server-side, not the client's claim. No limit on the number of files.
- Types (`ALLOWED_SUBMISSION_FILE_TYPES`, `lib/storage/homework-file.ts`): PDF,
  Word (`.doc`, `.docx`), JPEG, PNG, plain text, and audio (m4a, mp3, aac,
  webm, ogg) for a spoken answer.
- Objects live under `homework/<teacher>/<assignment>/<student>/`, built from
  server-known ids; finalizing re-derives the prefix, so a client cannot attach
  someone else's object.

## Review and feedback

- The teacher reviews one **attempt** at a time; every past attempt is visible
  with its own text and files.
- **One review per attempt, final.** A resubmission is a new attempt and gets
  its own feedback.
- Feedback: written content (1–5,000 characters, required), optional score
  0–`HOMEWORK_FEEDBACK_MAX_SCORE` (10), and one decision:
  - **Approved** → submission `graded`.
  - **Resubmission requested** → `returned`, and editable again whatever
    `allowResubmission` says.
  - **Rejected** → also `returned`; it differs from "resubmission requested"
    only in tone.
- Feedback on an attempt that is no longer the latest is saved but does not
  change the submission's status.
- The student is notified best-effort; a failed notification never blocks the
  feedback.

### Review with AI

- Teacher-triggered on one attempt, with an optional steer of up to 500
  characters (`HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS`).
- **Pro** (`gateProFeature(…, "homework_review")`, `canUseHomeworkAiReview`)
  and capped at **100** drafts per teacher per month
  (`HOMEWORK_AI_REVIEW_MONTHLY_CAP`), counted from `HomeworkAiReviewDraft`.
- The model reads the submitted text and any plain-text attachments; other
  files are named only. An audio answer is transcribed for it when
  `HOMEWORK_AUDIO_TRANSCRIPTION_ENABLED` is on and a transcription vendor is
  configured (`homeworkAudioTranscriptionEnabled()`).
- The draft is shown only to the teacher, never sent to the student, and kept
  so it can be audited or regenerated. Grading never needs it: at the cap, or
  with no Anthropic key, she reviews by hand.

## Reminders

Daily crons (`lib/inngest/functions/homework-reminder-nudge.ts`) nudge a
student whose assignment is still unsubmitted (no submission, or a draft):

- **Due soon** — `dueAt` within the next 24 hours (16:00 UTC run).
- **Overdue** — `dueAt` passed (18:00 UTC run).

Each is sent at most once per assignment, skips disabled students and archived
pairings, and respects the student's `class_materials` category
([notifications](notifications.md#categories-and-preferences)).

## Notifications

| Event                   | Recipient | Category           |
| ----------------------- | --------- | ------------------ |
| Assignment auto-drafted | Student   | `class_materials`  |
| Homework submitted      | Teacher   | `student_progress` |
| Feedback available      | Student   | `class_materials`  |
| Due soon / overdue      | Student   | `class_materials`  |

## User flow

- **Teacher, manual:** class page → Homework → Add → title, instructions, due
  date, late and resubmission toggles → save.
- **Student:** `/my-classes/[bookingId]/homework/[assignmentId]` — type
  (autosaved), attach files, submit. A blocked submit says why. After
  submitting the page is read-only until a decision reopens it.
- **Teacher, review:** class page → Homework → Review — attempts newest first;
  for an unreviewed one, optionally Review with AI, then write feedback, score,
  and decide.
- **Student, feedback:** the same page shows feedback and score; a returned
  submission can be edited and submitted again.

## Error states

- Empty submission — "add text or a file".
- Past due with late submission off — "past due".
- Submitted, resubmission off — "locked".
- File too large or of a disallowed type — rejected.
- Attempt already reviewed — second feedback rejected.
- Anything not the caller's (assignment, submission, attempt, file) — **not
  found**, never a permission error, so another tenant's data is not revealed.

## Permissions

| Action                       | Owning teacher          | Enrolled student    |
| ---------------------------- | ----------------------- | ------------------- |
| View assignment              | Yes                     | Yes, own class only |
| Create / delete assignment   | Yes                     | No                  |
| Edit assignment              | Not possible            | —                   |
| Submit / edit own submission | No                      | Yes, per the rules  |
| View submission and attempts | Yes, own students       | Own only            |
| Give feedback                | Yes, once per attempt   | No                  |
| Review with AI               | Yes (Pro + monthly cap) | No                  |
| View feedback                | Yes                     | Own only            |
