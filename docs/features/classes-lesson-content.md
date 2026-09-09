# Classes: lesson content & live notes

## Overview

Beyond the live video call, a class in SpiralClass carries three kinds of
supporting content:

1. **Class content** — a lesson plan/worksheet for one specific booking,
   either typed by the teacher or AI-drafted from the class's context
   (student level, interests, focus tags, teacher's own style) and then
   reviewed/edited before saving. Visible to the student on their booking
   page at any time (never scheduled/pushed).
2. **Lesson notes** — a lightweight, two-column running log a teacher keeps
   on a booking: private "cues" only she sees, and student-facing
   "instructions." Notes can be checked off during the live call and copied
   forward from the student's last class.
3. **Lesson summary** — an AI-generated recap of a class, built from that
   class's notes, generated on demand once the class has started.

Architecturally, "class content" is not a separate table — it is a
`LibraryMaterial` row scoped to one booking (`bookingId` set, `sendTiming`
null). The reusable, cross-class **library** of materials (level-gated,
browsable, assignable) is documented separately in
`docs/features/library-materials.md`; this document covers only the
booking-scoped content, lesson notes, and lesson summary. `LessonNote` and
`LessonSummary` are their own tables. `ClassContentGeneration` is not a
content table either — it is a pure per-teacher monthly counter that gates
AI usage (shared with library material generation and podcast generation).
`ClassContentTemplate` is a teacher-owned, reusable lesson-plan skeleton she
can save and reapply.

The two prior specs this page absorbed (deleted with the rest of the backlog
by [D-110](../decisions/D-110.md)) predate two architectural shifts (the
D-69 merge of the old standalone `ClassContent`/`ClassMaterial` models into
`LibraryMaterial`, and the D-72 narrowing to language teaching) — treat them
as historical rationale, not current schema truth.

## User Stories

- As a teacher, I want to jot down what I plan to cover in an upcoming class
  and what the student should know, so the class stays organized without a
  separate notebook.
- As a teacher, I want AI to draft a lesson plan for a specific student and
  class, using what I already know about them, so I don't start from a blank
  page every time.
- As a teacher, I want to reuse a lesson structure I've built before instead
  of retyping the same skeleton every class.
- As a teacher, I want to check off my private teaching cues live during the
  call so I know what's left to cover.
- As a teacher, I want to generate a summary of what happened in a class from
  my notes, so I have a record without writing it myself.
- As a student, I want to see what my teacher wants me to review or bring to
  the next class, and to see the lesson plan/content for my class.

## Business Rules (exhaustive)

### Class content (booking-scoped `LibraryMaterial`)

- Body is Markdown, capped at **20,000 characters** (`CLASS_CONTENT_MAX_CHARS`),
  trimmed and rejected if empty or over-cap — applies to manual and
  AI-reviewed content alike.
- Rendered as Markdown only (react-markdown), never raw HTML.
- App-layer convention: at most one body-bearing, unscheduled
  (`sendTiming: null`) material per booking is treated as "the content" —
  this is **not** a database constraint (no unique index), just a
  first-created-wins convention inherited from the old single-row
  `ClassContent` model. If a bug ever created two, the earliest by
  `createdAt` wins and the other is orphaned.
- Authoring (save/generate/manage templates) is **Pro-gated**
  (`gateProFeature(teacherId, "class_content")`). **Viewing** class content is
  free for both teacher and student on every plan.
- **AI generation** requires either a non-empty topic OR at least one
  focus/format tag — otherwise: "Pick a focus or describe what this class
  should cover." Up to 12 focus-tag ids per request; foreign/stale ids are
  silently dropped (never trusted as posted).
- **Monthly AI cap**: 100 successful generations per teacher per calendar
  month (`CLASS_CONTENT_AI_MONTHLY_CAP`), shared across class-content
  generation, library-material generation, "Edit with AI" refine, and podcast
  script generation — one AI budget, several outputs. Only a **successful**
  generation burns quota; a model failure records nothing.
- **Refine ("Edit with AI")**: free-text change instruction capped at 1,000
  characters (`MATERIAL_REFINE_INSTRUCTION_MAX_CHARS`); cannot run against an
  empty existing body (nothing to refine).
- **Template injection**: choosing a saved `ClassContentTemplate` injects up
  to 4,000 characters of its body as structure (`CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS`)
  — only the skeleton, not a full filled lesson. A foreign/deleted template
  id silently falls back to "no structure," never an error.
- **AI seed inputs**: the student's level, the `TeacherStudent` interests/goals,
  what the student's notebook already marks as covered (up to 25 recent
  titles), the teacher's account-level AI style preferences (tone/register,
  learner-age, target-language variety, free-text note — D-78), the language
  the teacher teaches (D-72), and a per-class vocabulary-difficulty override
  if set.
- **Vocabulary override precedence** (D-80): a class-level override beats the
  teacher's account default, which beats "everyday" as the fallback. Omitting
  the field on a generate request leaves any stored override untouched;
  passing a value (or explicit clear) persists it before generating.
- **Revision history**: every save that actually changes the body snapshots
  the outgoing (previous) body to `MaterialRevision`. A no-op save (identical
  body) creates no revision. Capped at **20 revisions per material**
  (`CLASS_CONTENT_MAX_REVISIONS`); oldest pruned first. Restoring an old
  revision is itself a save, so it's snapshotted too — restores are
  reversible in both directions.
- **Templates**: label capped at 80 characters
  (`CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS`); up to 100 saved templates per
  teacher (`CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER`, a sanity bound, not a
  plan gate). Teacher-scoped only — never shown to a student, never tied to a
  specific booking or level.
- **Podcast (optional add-on)**: a spoken rendition of the content's body can
  be generated (shares the class-content Pro gate and the same monthly quota
  pool — see `docs/features/library-materials.md` for the full podcast
  pipeline rules, which apply identically here).
- Content authored while the teacher was Pro remains **read-only** (never
  deleted) if she later downgrades to Free — documented policy in the
  historical `CLASS_CONTENT.md`, not independently re-verified against
  current code in this pass.

### Lesson notes (`LessonNote`)

- Two independent columns per booking: `audience: "teacher"` (private cues,
  only the teacher ever sees these) and `audience: "student"` (visible to the
  student, time-windowed — see below).
- **Free for every teacher, on every plan** — not Pro-gated. (Contrast with
  class content authoring, which is Pro-gated.)
- Body capped at **500 characters**, silently truncated on save (not
  rejected).
- `kind: "text"` (a normal cue) vs `kind: "bookmark"` (an in-call marker
  dropped live during the call, e.g. to flag a moment) — bookmarks are
  excluded from "copy notes from last class" and from lesson-summary
  generation.
- Ordering is an append-only positional list per (booking, audience); "move
  up/down" only swaps position with the adjacent neighbor in the same
  audience column — no free drag-reorder, and moving at either edge is a
  no-op.
- The "done" checkbox only applies to `audience: "teacher"` notes — a
  student-facing note can never be marked done, and a query for done notes
  never matches a student-audience row.
- **Copy notes from last class**: pulls the most recent _earlier_ booking for
  the same student that has `kind: "text"` notes (bookmarks excluded),
  appends them after the current tail in each audience column, and always
  **resets done-state** on copy ("a fresh class hasn't covered them yet"). If
  there's no earlier booking with notes, this is an explicit error, not a
  silent no-op.
- **Student visibility is a time window, not a stored flag** (D-15):
  student-facing notes become visible starting **15 minutes before**
  `scheduledStart` and remain visible until **30 minutes after**
  `scheduledEnd`. Teacher-audience notes are never visible to the student at
  any time — enforced at the query layer, not just the UI.
- Cascades: both `LessonNote` and `LessonSummary` are deleted if their parent
  booking is deleted.

### Lesson summary (`LessonSummary`)

- **Generation is Pro-gated** (`gateProFeature(teacherId, "lesson_notes")` —
  note this is a _different_ gate key than class content's `"class_content"`).
- One summary per booking (unique on `bookingId`); regenerating **overwrites**
  the existing summary rather than appending a history.
- Can only be generated **once the class has started** — generating before
  `scheduledStart` returns an explicit blocking error ("You can summarize the
  class once it has started").
- Requires **at least one note** (teacher cue or student instruction) on the
  booking — otherwise an explicit blocking error ("Add some notes to the
  class first").
- Only `kind: "text"` notes feed the summary prompt; bookmarks are excluded.
- Generated with a fixed model (`claude-haiku-4-5`), independent of any
  environment-level model override, for latency reasons on this path.
- If no AI credentials are configured, generation fails gracefully with a
  "not available" message rather than a server error.
- **Teacher-only, always** — there is no student-facing surface for a lesson
  summary on either platform.

## User Flow

**Teacher — lesson notes, before/during/after a class:**

1. Open the class detail page (any time before or after the class).
2. Write private cues (teacher column) and/or student-facing instructions
   (student column) — 500 characters each, free on every plan.
3. Optionally copy forward the previous class's notes for this same student
   (resets any "done" marks).
4. During the live call, check off teacher cues as they're covered; optionally
   drop an in-call bookmark to mark a moment.
5. After the class has started, optionally generate an AI summary from the
   notes (Pro-gated); regenerating replaces the stored summary.

**Teacher — class content, per booking:**

1. Open the class-content panel on a booking. See any existing content, saved
   templates, the teacher's focus-tag taxonomy, available levels, and the
   class's vocabulary-difficulty override versus the account default.
2. Either type content directly, or (Pro + within monthly cap) trigger
   "Generate with AI" — optionally supplying a topic, up to 12 focus/format
   tags, a saved template's structure, an output-language override, and a
   vocabulary-difficulty override.
3. Review and edit the AI draft (or use "Edit with AI" to apply a targeted
   change instruction).
4. Save — this persists the body, snapshots a revision if the body changed,
   and best-effort triggers a homework draft.
5. Optionally generate a spoken podcast rendition from the same body, or save
   the current structure as a reusable template.

**Student — viewing:**

- Views class content on their booking detail page at any time — free on
  every plan, no time window.
- Sees student-facing lesson notes only within the 15-minutes-before to
  30-minutes-after window; never sees teacher cues, the lesson summary, or
  templates.

## Data Used

- **Class content**: the booking, the student's level and interests/goals,
  what the student's personal library already marks as covered, the
  teacher's saved AI style preferences and chosen language, focus/format
  tags, an optional saved template, and (for AI) the model's draft.
- **Lesson notes**: the booking, the student, timestamped teacher/student
  entries with an explicit audience and done-state.
- **Lesson summary**: the booking's lesson notes (text only), producing one
  stored summary per booking with model provenance recorded.

## Edge Cases

- Two content-material rows on one booking (should never happen, not
  DB-enforced): the earliest-created one is treated as "the" content; the
  other is orphaned but not deleted.
- Teacher hits the monthly AI cap mid-session: no model call is made, no
  quota burned, teacher is told she can still write manually.
- AI credentials not configured in the environment: generation/summary
  degrade to a friendly "not available" message instead of a 500; manual
  authoring still works.
- A foreign, stale, or deleted template id is submitted: falls back silently
  to no injected structure.
- Copying notes forward when there is no earlier booking with notes for that
  student: explicit error, no rows created.
- Moving a note at the top/bottom of its column: no-op, no error.
- Regenerating a lesson summary: silently overwrites the previous one (no
  history retained).
- Booking is deleted: its lesson notes and lesson summary are cascade-deleted.

## Error States

- Non-Pro teacher tries to author/generate content, save a template, or
  generate a lesson summary → upgrade-nudge message, no write, no AI call.
- Empty/missing audience, or empty note body, on note create → rejected
  before any database write.
- Note/template/content action targeting a booking or note not owned by the
  calling teacher → not-found/no-op — never leaks another tenant's data.
- Class-content generation with no topic and no tags → validation error
  before any model call.
- Booking not found (deleted, or belongs to another teacher) → not-found
  error.
- Monthly AI cap already reached → capped error, no model call, no quota
  burned.
- Model call fails → generic error surfaced to the teacher, no quota burned.
- Lesson summary requested before the class started → explicit blocking
  error.
- Lesson summary requested with zero notes on the booking → explicit
  blocking error.
- Lesson summary requested with no AI credentials configured → friendly
  "not available" message.
- Model returns an empty summary → explicit "summary came back empty" error.

## Permissions

| Action                                        | Owning teacher          | Other teacher | Student                           |
| --------------------------------------------- | ----------------------- | ------------- | --------------------------------- |
| View class content                            | Yes                     | No            | Yes (free, any time)              |
| Author/edit/delete class content              | Yes (Pro)               | No            | No                                |
| Generate/refine class content with AI         | Yes (Pro + monthly cap) | No            | No                                |
| Save/manage templates                         | Yes (Pro)               | No            | No — never shown                  |
| Write/edit/delete lesson notes (both columns) | Yes (free)              | No            | No                                |
| View student-facing note                      | Yes                     | No            | Yes, time-windowed only           |
| View teacher cue                              | Yes                     | No            | Never                             |
| Generate/regenerate lesson summary            | Yes (Pro)               | No            | No                                |
| View lesson summary                           | Yes                     | No            | Never — no student surface exists |

## Open Questions

- **Lesson-summary i18n key naming**: the summary card reads its copy from
  `web.dashboard.classes.summary.*`, a different naming convention than the
  `classContent.*`/`lessonNotes.*` catalogs used everywhere else in this
  feature area. Likely a small drift, not a bug — worth normalizing at some
  point.
- **No database-level uniqueness** enforces "one content material per
  booking" — it is purely an application convention. If a race or bug ever
  creates two, "first one wins" is unverified as an explicit, tested
  guarantee rather than incidental behavior.
- **Lesson summary has no student surface at all** — it is a teacher-dashboard
  artefact. Confirm whether that is an intentional scope decision or a gap.
