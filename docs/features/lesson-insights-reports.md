# Lesson insights & student reports

## Overview

**Status: fully built; ENABLED in both environments as of
[D-131](../decisions/D-131.md) (2026-08-26).** The reasoning lives in
[D-19](../decisions/D-19.md), [D-21](../decisions/D-21.md) and
[D-22](../decisions/D-22.md).
The flag history is: off at first ship, on at
[D-94](../decisions/D-94.md) (2026-07-21), off again at
[D-114](../decisions/D-114.md) (2026-08-08) ahead of first promotion, and on
again at D-131 (2026-08-26). **This pipeline captures student voice, including
minors.** What decides whether any given student is captured is the recorded
per-pairing consent (D-22), which is guardian-only for a student under 18 —
never the flag. Read D-131 before reversing this.

Two operational facts D-131 records and this document must not contradict: the
**teacher's Record tap is the reliable trigger** for insights capture (the
automatic `participant_joined` path races LiveKit track publication and is
best-effort), and **preview cannot rehearse the pipeline end-to-end** because
the shared LiveKit box posts webhooks to production's URL only.

`config/env/{preview,production}.runtime.env` is the source of truth on what
is actually enabled — see the flag-by-flag breakdown under the consent gate
below. Two things that are true regardless of any flag: nothing is captured
for a pairing without that pairing's own consent (below), and this document
describes the built behavior rather than asserting any given teacher has it
switched on.

Once enabled (per teacher, opt-in consent required), the feature turns a
class's recorded audio into structured, teacher-facing analytics: per-class
findings (`LessonInsight`) across five categories, a rolling
per-student `StudentLearningProfile` built only from findings the teacher has
confirmed, an on-demand pre-class prep brief (`LessonBrief`), pronunciation
scoring (`LessonPronunciation`), and a spaced-repetition vocabulary queue
(`VocabularyReview`) the student can review themselves. This is the "Reports"
area for a teacher to track a student's progress over time, distinct from
the pass/fail record of attendance or payments.

## User Stories

- As a teacher, I want AI to surface patterns in a student's speaking (a
  recurring grammar mistake, a mispronounced word) without me having to
  transcribe or review the recording myself.
- As a teacher, I want to confirm, edit, or dismiss an AI finding before it
  counts toward that student's tracked progress, so bad AI guesses don't
  pollute the record.
- As a teacher, I want a short "what to focus on" brief before a class,
  drawing on the student's accumulated profile.
- As a teacher, I want to control whether a student's captured audio is even
  analyzed at all, especially for a minor student.
- As a student, I want to optionally see a simplified view of my own
  progress, and review vocabulary flagged from my own classes.

## Business Rules (exhaustive)

### Consent gate (the central rule — D-19/D-21/D-22)

- Voice-capture-based analysis is **off by default** for every
  teacher-student pairing. Nothing is captured or analyzed unless consent is
  satisfied.
- For a **minor** student, only the **guardian's** consent
  (`guardianConsentAt`) counts — the minor's own consent can never
  substitute.
- For an **adult** student, only their own consent (`insightsConsentAt`)
  counts.
- Both consent fields default to unset/off; there is no default-on cohort.
- If consent isn't satisfied, the audio-capture step for insights is skipped
  silently — this does **not** affect the ordinary class call recording
  itself, which is a separate, unrelated capability; only the
  insights-specific voice-analysis pipeline is gated on this consent.
- **Enablement flags, independent of per-pairing consent.** Three flags bear
  on this pipeline, and no one of them can be inferred from another.
  `config/env/{preview,production}.runtime.env` is the source of truth — read
  it rather than assuming this document's description means a given half is
  live:
  - `LESSON_INSIGHTS_TRANSCRIPTION_ENABLED` is **on** in both environments
    ([D-131](../decisions/D-131.md)). It was held off from the start, turned on
    by [D-94](../decisions/D-94.md) (2026-07-21), turned back off by
    [D-114](../decisions/D-114.md) (2026-08-08) ahead of first promotion, and
    turned on again by D-131 (2026-08-26). **The
    flag is necessary, not sufficient**: without `DEEPGRAM_API_KEY` in
    Infisical, `transcriptionEnabled()` is false and the pipeline is dormant
    with green CI. (The older spec this
    bullet used to point at was deleted in the
    [D-110](../decisions/D-110.md) reset.)
  - `CLASS_RECORDING_ENABLED` is **on** in both environments (D-131), so the
    teacher's Record control is shown and the server will start a
    room-composite recording — provided `LIVEKIT_EGRESS_S3_*` is set on the Fly
    app (Tofu-owned, in no file in this repo) and the teacher is on Pro. Note
    it is _not_ what gates insights capture: as of D-114
    `maybeStartLessonAudioCapture` requires `transcriptionEnabled()`, so the
    transcription flag above is the one that decides whether any lesson audio
    is captured at all. In practice the Record tap is nonetheless the reliable
    way to get insights audio, because the automatic path races track
    publication — see D-131.
  - `LESSON_INSIGHTS_PRONUNCIATION_ENABLED` is **off everywhere** — unset in
    production, a commented example on preview — so `pronunciationEnabled()`
    is false and no phoneme score has ever reached a student. Its own gate is
    separate from transcription's: Phase D sends student voice to a _second_
    vendor (Azure), whose coverage was never confirmed. Because it is dark,
    the public marketing pages must not advertise it;
    `apps/web/tests/config/ai-marketing-claims.test.ts` enforces that both
    ways and fails if the flag flips without the claim being restored.

### Pipeline (async, post-class)

- Fully asynchronous, background-job driven: call → per-participant audio
  capture → uploaded to storage → transcribed (Deepgram is the only
  implemented vendor; a second vendor was designed for but never built) →
  Claude-based analysis produces `LessonInsight` rows (all tagged
  `source: "ai"`) → teacher reviews/confirms → the student's profile is
  recomputed.
- Pronunciation scoring runs from the audio (via Azure) before the
  derive-then-discard step, since scoring needs the raw audio, not just the
  transcript.
- **Retention default is derive-then-discard**: raw audio is deleted once
  the transcript and pronunciation score are extracted, unless the teacher
  has opted in to retaining it (`Teacher.lessonAudioRetentionOptIn`). No
  explicit time-bound retention window for the opted-in, kept-audio path was
  found — only the boolean opt-in itself.

### Insight generation and caps

- At most **3 insights per category** are generated per class (5 categories:
  pronunciation, grammar, vocabulary, fluency, comprehension) — enforced both
  in the prompt and defensively in code, preserving the model's own
  most-important-first ordering.
- **Pronunciation-finding rule flips based on data availability**: without a
  pronunciation score for the class, the prompt explicitly forbids guessing
  pronunciation problems from spelling alone — it can only cite an explicit
  teacher note/correction. With a score present, findings must be anchored
  only to scored "weak words," never invented.
- Weak-word threshold: an accuracy score below **60** (0–100 scale, lower is
  worse) qualifies as "weak," capped at the 12 worst words, sorted worst
  first.
- Malformed or partially-malformed AI output degrades gracefully — individual
  bad items are dropped, valid ones kept; a completely malformed/empty
  response degrades to an empty result set rather than throwing.
- No AI credentials configured → insight/brief generation fails gracefully
  (no analysis produced, no error surfaced to the student, teacher sees "not
  available").

### Confirm / edit / dismiss / add (the teacher review loop)

- **Only confirmed, non-dismissed insights ever enter a student's tracked
  profile.** An unconfirmed AI suggestion or a dismissed one is excluded from
  every rollup, verified by an integration test that recomputes and asserts
  only confirmed rows contribute.
- Confirming an insight sets `confirmedAt`, clears any `dismissedAt`, and
  (if not already set) derives a canonical `skill` grouping key — then
  triggers a profile recompute.
- Editing an insight implicitly confirms it.
- Dismissing sets `dismissedAt`, clears `confirmedAt` — a dismissed insight
  never feeds the profile again, but the recompute still runs (to remove it
  from a profile it may have previously contributed to before being
  dismissed).
- A teacher can also add her own finding directly (`source: "teacher"`),
  which is confirmed immediately on creation.
- Re-running AI analysis on a class only ever deletes/replaces prior
  **unconfirmed** AI rows for that class (`source: "ai" AND confirmedAt IS
NULL`) — a confirmed insight is never touched or removed by regeneration.
- All of these actions are **Pro-gated**.
- Ownership check is by `teacherId` match — accessing/editing an insight
  belonging to another teacher's booking returns a not-found response, not a
  403, to avoid leaking existence of another tenant's data.

### Profile rollup (`StudentLearningProfile`)

- Materialized, **not** the source of truth — fully recomputed from
  confirmed `LessonInsight` rows on every relevant mutation (confirm, edit,
  dismiss, add).
- Grouped `byCategory → bySkill`, each entry tracking recurrence count, first-
  and last-seen timestamps, a trend (`"focus"`, `"improving"`, or `"new"`),
  and the last piece of supporting evidence.
- **Trend logic**: a skill absent from the student's last 2 classes reads as
  "improving"; a skill seen recently that has recurred 2+ times reads
  "focus"; anything else is "new."
- A separate **vocabulary queue** is built from `category: "vocabulary"`
  insights, deduplicated by normalized term (keeping the latest sighting),
  ordered newest-first.
- A **speaking-balance** metric (teacher-share vs. student-share of talk
  time across lessons, D-97) is computed independently of confirmed insights
  — from any lesson that has both a recording and a transcript, averaged
  across lessons.
- If a student ends up with zero confirmed insights and no speaking-balance
  data, the stale profile row is **deleted** outright rather than left as an
  empty shell.

### Pre-class brief (`LessonBrief`)

- On-demand, generated when the teacher opens an **upcoming** booking; cached
  one per booking, only regenerated when the cached brief is older than the
  student's profile's last update.
- Capped at **3 focus cues** per brief.
- Only "focus" and "new" skills are surfaced as actionable cues; "improving"
  skills are encouragement-only and are never nagged in a brief.
- A one-tap "Add as cue" action stages a suggested focus point straight into
  the teacher's live lesson notes for that booking.
- Degrades to no brief at all (never an error) if there's no profile, no
  signal, or no AI credentials configured.

### Vocabulary spaced repetition (`VocabularyReview`)

- Classic **SM-2** algorithm. Grades are `again` / `hard` / `good` / `easy`,
  mapped internally to quality scores.
- First successful review: `good` → 1 day, `easy` → 4 days, `hard` → 1 day.
- Second review (at interval = 1 day): `good` → 6 days; `hard` stays at 1
  day.
- Later reviews: `good` multiplies the interval by the ease factor; `hard`
  multiplies by 1.2.
- `again` resets the interval to 0 and re-surfaces the term in **10
  minutes**.
- Ease factor floors at **1.3**, defaults to **2.5**.
- Seeding new terms from the profile's vocabulary list is idempotent — a
  re-seed never resets an in-progress term's existing schedule.

### Visibility to the student

- `LessonInsight`, `LessonPronunciation`, and `LessonBrief` are **teacher-only,
  always** — no raw transcript, quoted evidence, category, or trend detail
  ever reaches a student directly.
- `StudentLearningProfile` is teacher-only **by default**; a student sees only
  a deliberately reframed derivative (skills bucketed as "improving" vs.
  "worth practising," with no evidence, category, or trend labels), and only
  once the teacher has explicitly toggled per-student "share progress" on
  (off by default).
- `VocabularyReview` is directly student-facing and actionable once seeded —
  it's literally the student's own review queue.
- A superadmin pipeline-health dashboard shows only **counts and stage
  timestamps** (capturing → ready → transcribed → insights → pronunciation →
  profiles → briefs) plus stuck-capture detection — it deliberately never
  surfaces any transcript/insight/profile content, by design, consistent
  with the privacy stance of D-21/D-22.

## User Flow

**Teacher — student detail page:**

1. Open a student's profile; see a read-only rollup card: focus areas sorted
   by recurrence (ties favor "focus" trend), each with skill, category,
   evidence quote, trend badge, and recurrence count, followed by a
   vocabulary badge cloud.
2. Below that, controls for insights consent (with a minor-specific
   checkbox) and the "share progress with student" toggle.

**Teacher — booking/class detail page:**

1. **Before an upcoming class**: a prepare card shows the brief's summary and
   up to 3 focus cues, each with a one-tap "Add as cue" that stages it into
   live lesson notes.
2. **After a completed/analyzed class**: a focus-areas panel groups AI
   findings by category (fixed order: pronunciation, grammar, vocabulary,
   fluency, comprehension), each with Confirm (choosing/confirming a skill
   grouping), Edit, and Dismiss actions, plus a free-form "add your own
   finding" row.

**Student — "Your progress" (only if shared):**

1. Visible per-teacher only once that teacher has turned sharing on.
2. Shows reframed "improving" vs. "worth practising" groupings — never raw
   category/evidence data.
3. A one-at-a-time vocabulary flashcard review: flip to see context, grade
   `again`/`hard`/`good`/`easy`.

**Admin — pipeline health (superadmin only):**

1. Sees stage counts/timestamps and stuck-capture alerts only — zero content.
2. A warning banner appears if live transcription is enabled in production.

## Data Used

Per-class findings (category, summary, evidence, suggestion, timeline
position, source), pronunciation scores (overall accuracy/fluency/
completeness/pron + per-weak-word detail), a rolling per-student profile
(skills grouped by category with trend/recurrence), a cached pre-class
brief, and a vocabulary spaced-repetition schedule per (teacher, student,
term).

## Edge Cases

- A student's stored profile JSON is malformed/legacy-shaped: treated as "no
  profile" and the page renders an empty state rather than crashing.
- Re-running analysis on a class that already has confirmed insights: only
  unconfirmed AI rows are replaced; confirmed findings survive untouched.
- A profile that drops to zero confirmed insights and no speaking-balance
  data: the row is deleted rather than kept as an empty shell.
- Seeding vocabulary review terms that already exist for that student: the
  existing schedule is left alone (idempotent seed via database-level
  duplicate-skip), never reset.
- No-show or cancelled classes: not explicitly special-cased in the reviewed
  code — the pipeline is implicitly gated on there being an actual audio
  capture + transcript in the first place, which only happens for a class
  that was genuinely recorded. Behavior for a cancelled/no-show booking was
  not directly verified by a test in this pass.

## Error States

- Non-Pro teacher attempts to confirm/edit/dismiss/add an insight, toggle
  consent, or toggle progress-sharing → blocked with an upgrade nudge. A route
  handler answering the same call surfaces it as an HTTP 402 plan-limit
  response.
- Action targets an insight not owned by the calling teacher → not-found
  response, no database write, no profile recompute — avoids leaking
  cross-tenant existence.
- Empty summary on an edit or manually-added insight → rejected as invalid
  before any write.
- No AI credentials configured → insight/brief generation degrades to "not
  available," never a hard failure.
- Pronunciation scoring is skipped (not an error) for any of: feature
  disabled, unsupported language, no reference text available, no scoring
  vendor configured.

## Permissions

| Action                                    | Teacher (owner) | Other teacher  | Student (own)                                 | Student (other) | Admin/superadmin                   |
| ----------------------------------------- | --------------- | -------------- | --------------------------------------------- | --------------- | ---------------------------------- |
| View profile/insights/pronunciation/brief | Yes             | No (not-found) | No (only a reframed progress view, if shared) | No              | Counts/timestamps only, no content |
| Confirm/edit/dismiss an insight           | Yes (Pro)       | No             | No                                            | No              | No                                 |
| Add a teacher-authored insight            | Yes (Pro)       | No             | No                                            | No              | No                                 |
| Record/revoke insights consent            | Yes (Pro)       | No             | No                                            | No              | No                                 |
| Toggle "share progress"                   | Yes (Pro)       | No             | No                                            | No              | No                                 |
| View own reframed progress                | N/A             | N/A            | Yes, only if shared                           | No              | No                                 |
| Grade a vocabulary review                 | N/A             | N/A            | Yes (own queue only)                          | No              | No                                 |

Server actions and route handlers call the same underlying business-logic
functions, so these rules cannot drift between entry points.

## Open Questions

- **No-show/cancelled-class behavior is unverified.** No test was found
  asserting what happens to insight generation for a cancelled or no-show
  booking. The pipeline appears to implicitly skip these (no recording, no
  transcript, nothing to analyze) but this should be explicitly confirmed
  with whoever owns the capture-trigger logic before treating it as a
  guarantee in QA test plans.
- **Production activation status changes independently of this document.**
  Because the feature is gated by both per-pairing consent and a production
  feature-flag gate, whether it is actually live for any real
  teacher at a given moment must be checked against the deployed flag values
  (`config/env/*.runtime.env`) and the vendor keys in Infisical, not assumed
  from this document's description of built behavior.
- **Transcription vendor is Deepgram-only today.** A second vendor
  (AssemblyAI) is named in the design doc as a fallback option, but no
  adapter for it exists in code — treat it as "designed for," not shipped.
- **Retention window for opted-in audio** is a boolean
  (`lessonAudioRetentionOptIn`), not a bounded time window — no explicit
  "kept for N days then deleted" policy was found for teachers who opt in to
  retaining raw audio past the derive-then-discard default.
