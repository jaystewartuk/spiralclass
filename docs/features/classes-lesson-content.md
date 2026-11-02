# Classes: lesson content & live notes

Besides the call itself, a class carries three kinds of content:

1. **Class content** — a lesson plan or worksheet for one booking, typed by the
   teacher or AI-drafted from what she knows about the student, then reviewed
   before saving. The student can read it on her class page at any time.
2. **Lesson notes** — a two-column running list on a booking: private teacher
   **cues** and student-facing **instructions**. Cues can be ticked off during
   the call and copied forward from the student's last class. The **day plan**
   is a notebook view over the cues for one day.
3. **Lesson summary** — an AI recap of a class, built from its notes.

Class content is not its own table: it is a `LibraryMaterial` with `bookingId`
set and `sendTiming` null. The reusable library,
attachments, revisions, podcasts and the answer-key rule are in
[library materials](library-materials.md). `LessonNote` and `LessonSummary` are
their own tables. `ClassContentGeneration` is a per-teacher monthly counter
that meters AI use. `ClassContentTemplate` is a teacher's saved lesson-plan
skeleton.

## Class content

- Markdown body, trimmed, rejected if empty or over **20,000 characters**
  (`CLASS_CONTENT_MAX_CHARS`, `lib/materials/config.ts`). Rendered as Markdown
  only, never raw HTML.
- "The content" of a booking is its first-created body-bearing, unscheduled
  material. This is an application convention with no unique index behind it.
- **Authoring is Pro** (`gateProFeature(teacherId, "class_content")`): saving,
  generating, refining and managing templates. **Viewing is free** for teacher
  and student on every plan. Content written on Pro stays readable after a
  downgrade ([subscriptions](subscriptions.md)).
- **AI generation** needs a topic or at least one focus/format tag. Up to 12
  focus-tag ids per request; ids that are not the teacher's own active tags are
  dropped.
- **Monthly AI cap**: 100 successful generations per teacher per calendar month
  (`CLASS_CONTENT_AI_MONTHLY_CAP`), one pool shared by class-content and library
  generation, "Edit with AI" and podcast scripts. Only a success uses quota.
- **Edit with AI** (refine): an instruction of up to 1,000 characters
  (`MATERIAL_REFINE_INSTRUCTION_MAX_CHARS`); refuses an empty body.
- **Templates**: choosing one injects up to 4,000 characters of its body as
  structure (`CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS`); a foreign or deleted id
  means "no structure", not an error. Label ≤ 80 characters, up to 100 per
  teacher (a sanity bound, not a plan limit). Teacher-only; never shown to a
  student.
- **Prompt inputs**: the student's level, the pairing's interests and goals, up
  to 25 titles her notebook already marks covered, the teacher's style presets
  and note ([D-17](../decisions/D-17.md)), the language the teacher teaches
  ([D-72](../decisions/D-72.md)), and the vocabulary-difficulty setting.
  "Continue from a previous class" is in
  [library materials](library-materials.md#ai-generation-refine-and-templates).
- **Vocabulary difficulty**: a per-class override beats the teacher's account
  default, which beats "everyday". Omitting the field on a generate request
  leaves a stored override untouched; sending a value (or an explicit clear)
  saves it first.
- Saving best-effort drafts homework from any `[!homework]` or `[!exercise]`
  block ([homework](homework.md#auto-drafted-assignments)).

## Lesson notes

`LessonNote` rows on a booking, with `audience` `teacher` (cues) or `student`
(instructions).

- **Writing notes is free on every plan.** Body ≤ 500 characters, silently
  truncated.
- `kind: "text"` is a note; `kind: "bookmark"` is an in-call marker
  ([live calls](live-calls-video.md#call-controls)). Bookmarks are left out of
  copy-forward and the summary.
- Each audience column is an ordered list. Move up/down swaps with the
  neighbour; at either end it is a no-op.
- Only teacher cues can be ticked done.
- **Copy from last class** takes the student's most recent earlier booking that
  has text notes, appends them to each column, and clears every done mark. No
  such booking is an explicit error.
- **The student sees her instructions only from 15 minutes before
  `scheduledStart` to 30 minutes after `scheduledEnd`**
  (`NOTE_VISIBLE_BEFORE_MIN`, `NOTE_VISIBLE_AFTER_MIN`). There is no stored
  "published" flag and no go-live switch — do not add one. Every student read
  path applies the window server-side through `lessonNoteStudentVisible`
  (`lib/lesson-notes/visibility.ts`), so a teacher can write days ahead without
  leaking anything. Teacher cues never reach the student.
- **The live surfaces are Pro** (`canUseLiveNotes`, gate key `lesson_notes`):
  notes over the call stage, and the lesson summary. The student's notes card on
  her class page is gated by the window only.
- In the call, each side's notes show in a collapsible card at the top-left of
  the stage; each browser remembers whether it was collapsed.
- Notes and the summary are deleted with their booking.

## Day plan (`/dashboard/classes/plan`)

The teacher's planning notebook: one page per day, one section per class, a few
bullets each. It is **a view, not a table** — each bullet is a teacher cue
(`audience: "teacher"`, `kind: "text"`), the same list she ticks off in the call
and that copy-forward carries.

- The day is the teacher's local calendar day. `?d=YYYY-MM-DD` picks it; a
  missing or invalid value means her today.
- Lists her classes starting that day in `scheduled`, `completed` or `no_show`,
  earliest first. Cancelled and rescheduled classes are not shown.
- Teacher column only. Instructions, materials and class content stay on the
  class page.
- Each cue is a checkbox and one line; tapping the line edits it in place
  (save, cancel, move, remove); ticking is immediate.
- Every note rule above applies. The forms post `from=plan` so the action
  refreshes the plan instead of the class page; the field picks between two
  fixed paths and never carries one.
- A class is flagged **last of its package** when the package is fully
  committed (`classesUsed ≥ classesTotal`) and no later class in it is still
  booked. A class with no package is never flagged.

## Lesson summary

- **Pro** (gate key `lesson_notes`, not `class_content`).
- One per booking; regenerating overwrites it.
- Only once the class has started, and only with at least one note; both are
  explicit errors otherwise. Only text notes feed it.
- Model is `SUMMARY_MODEL` (`claude-haiku-4-5`, `lib/lesson-notes/summary.ts`),
  fixed regardless of any environment model override.
- No AI key → a "not available" message. An empty model reply is an explicit
  error.
- Teacher-only; there is no student surface for it.

## Error states

- Non-Pro teacher authors content, saves a template or summarizes → upgrade
  nudge, no write, no AI call.
- Booking, note, template or material not the caller's → not found.
- Generation with no topic and no tags → validation error before any model
  call.
- Monthly cap reached, or the model fails → error, no quota used; manual
  authoring still works.

## Permissions

| Action                              | Owning teacher          | Student                |
| ----------------------------------- | ----------------------- | ---------------------- |
| View class content                  | Yes                     | Yes (free, any time)   |
| Author/edit/delete class content    | Yes (Pro)               | No                     |
| Generate/refine with AI             | Yes (Pro + monthly cap) | No                     |
| Save/manage templates               | Yes (Pro)               | No — never shown       |
| Write lesson notes (both columns)   | Yes (free)              | No                     |
| See student instructions            | Yes                     | Yes, inside the window |
| See teacher cues                    | Yes                     | Never                  |
| Use the day plan                    | Yes (free)              | No                     |
| Generate or view the lesson summary | Yes (Pro to generate)   | Never                  |

No other teacher can see or act on any of it.
