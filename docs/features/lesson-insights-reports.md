# Lesson insights & student reports

Turns a class's transcript into teacher-facing analytics: per-class findings
(`LessonInsight`) in five categories, a per-student `StudentLearningProfile`
built only from findings the teacher confirmed, a pre-class brief
(`LessonBrief`), pronunciation scores (`LessonPronunciation`, dark), and a
spaced-repetition vocabulary queue (`VocabularyReview`) the student works
through herself. Reasoning: [D-22](../decisions/D-22.md) (consent and
retention) and [D-185](../decisions/D-185.md) (transcript from captions).

> [!IMPORTANT]
> **This pipeline reads student speech, including minors'.** Whether a given
> student's words are kept is decided by that pairing's recorded consent —
> the guardian's for a student under 18 — never by a flag.

Two operational facts:

- **The teacher's captions toggle only controls display.** A consenting class
  is recognised and kept whether or not captions are showing; both participants
  see the learning-notes indicator ([D-203](../decisions/D-203.md)).
- **Preview cannot rehearse it end to end**: preview has no LiveKit key pair
  ([live calls](live-calls-video.md#joining-and-connection)).

## Flags

`config/env/{preview,production}.runtime.env` is the source of truth for what
is on; read it rather than this page. No flag can be inferred from another.

| Flag                                    | Gates                                                                                                                           | Preview | Production |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| `LESSON_INSIGHTS_TRANSCRIPTION_ENABLED` | `browserTranscriptEnabled()`: keeping caption lines as the transcript. Insights also need `ANTHROPIC_API_KEY`.                  | on      | on         |
| `CLASS_RECORDING_ENABLED`               | The Record control and the legacy per-speaker audio capture. Does **not** gate the transcript.                                  | off     | off        |
| `LESSON_INSIGHTS_PRONUNCIATION_ENABLED` | `pronunciationEnabled()`: Azure phoneme scoring, a second vendor receiving student voice. Needs raw audio, so never runs today. | off     | off        |

- The legacy audio path (`transcriptionEnabled()`: egress → R2 → Deepgram batch
  → derive-then-discard, `lib/transcription/pipeline.ts`) needs the
  transcription flag, a vendor key **and** recording on, so it is dormant.
- Because pronunciation is dark, public marketing must not advertise it;
  `apps/web/tests/config/ai-marketing-claims.test.ts` fails if a claim and its
  flag disagree, in either direction.

## Consent

- Off by default for every teacher-student pairing; there is no default-on
  cohort.
- **Adult**: her own consent (`insightsConsentAt`). **Minor**: only the
  guardian's (`guardianConsentAt`); her own never substitutes. A class for two
  also needs the buyer's confirmation for the second person (D-149, see
  [live calls](live-calls-video.md#the-lesson-transcript)).
- Without consent nothing of either speaker is kept. It does not affect the
  call recording, which is a separate capability.
- Recording and revoking consent is Pro.

## Pipeline

1. Whether or not captions are showing (D-203), when the class's caption session carries
   `transcriptCapture` (flag on and consent recorded), the browser that
   recognised a finished utterance posts its text, speaker and estimated
   duration to `POST /api/captions/transcript`. The server re-checks access and
   consent and appends it atomically to the booking's `LessonTranscript`
   (provider `browser-live`). Both participants are told learning notes are on
   and see a notes icon in the call's top bar.
2. On LiveKit `room_finished` — or an Inngest fallback 30 minutes after the
   scheduled end (`CAPTURE_GRACE_MS`) — the row is rebased to a 0-based
   timeline, marked `browser`, and `lesson.transcript.ready` fires. Later lines
   are dropped.
3. Claude produces `LessonInsight` rows (`source: "ai"`); the teacher confirms,
   edits or dismisses; the profile is recomputed.

- **The lesson's language is the teacher's own** (`lessonLanguage`,
  `lib/transcription/language.ts`): her subject (`target_language`), else the
  language she teaches in (`teaching_language`), never her `locale`. It tags
  the `LessonTranscript`, and the brief and insights grade against it, read
  from the teacher rather than from the stored tag (a transcript written
  before this was resolved carries `"es"`). Each line's text is recognised in
  the language its speaker speaks in that class, the same per-class answer the
  captions use (`classSpokenLanguages`).
- A transcript is kept while the teacher's account is open and deleted with it
  ([account settings](account-settings.md#account-deletion)).
  `Teacher.lessonAudioRetentionOptIn` applies only to the legacy audio path.

## Insights

- At most **3 per category** (`MAX_INSIGHTS_PER_CATEGORY`), in the model's
  own priority order. Categories, in display order: pronunciation, grammar,
  vocabulary, fluency, comprehension.
- **Pronunciation findings**: without a pronunciation score, the prompt
  forbids guessing from spelling — only an explicit teacher note or correction
  counts. With a score, findings must anchor to scored weak words: accuracy
  below 60 (`WEAK_WORD_ACCURACY_THRESHOLD`), the 12 worst (`MAX_WEAK_WORDS`).
- Malformed model output drops the bad items and keeps the rest; a wholly
  malformed reply is an empty result. No Anthropic key → nothing generated, the
  teacher sees "not available".

### Teacher review loop

- **The verdicts are the model's score card** ([D-201](../decisions/D-201.md)).
  Confirmed over confirmed-plus-dismissed, across every AI row on real
  accounts, is shown on the admin overview — counts only, never an insight's
  text (D-22). Unreviewed rows are shown beside it and do not dilute the rate.
  The offline evals (`pnpm evals`) measure the same surface before a prompt or
  model change; this figure is what says whether the change held up in
  classes.

- **Only confirmed, non-dismissed insights enter the profile.**
- Confirm sets `confirmedAt`, clears `dismissedAt`, derives a `skill` grouping
  key if missing, and recomputes. Editing confirms.
- Dismiss sets `dismissedAt`, clears `confirmedAt`, and recomputes (to remove it
  from the profile).
- The teacher can add her own finding (`source: "teacher"`), confirmed on
  creation.
- Re-running analysis replaces only **unconfirmed AI** rows for that class; a
  confirmed insight is never touched.
- All of these are Pro. Another teacher's insight is **not found**, not 403.

## Profile (`StudentLearningProfile`)

- Materialized and fully recomputed from confirmed insights on every confirm,
  edit, dismiss or add.
- Grouped by category → skill, each with recurrence count, first and last seen,
  latest evidence and a trend: a skill absent from the student's last 2 classes
  (`RECENT_LESSONS_WINDOW`) is **improving**; seen recently and recurring 2+
  times is **focus**; otherwise **new**.
- A vocabulary list from `vocabulary` insights, deduplicated by normalized term
  (latest sighting kept), newest first.
- **Speaking balance** (teacher vs student share of talk time) comes from any
  lesson with a transcript, independent of confirmations, averaged across
  lessons. Lesson length is the audio duration where a legacy audio row exists,
  otherwise the last utterance's end.
- With no confirmed insights and no speaking-balance data, the profile row is
  deleted. A malformed stored profile reads as "no profile".

## Pre-class brief (`LessonBrief`)

- Generated when the teacher opens an **upcoming** booking; cached per booking
  and regenerated only when older than the profile's last update.
- At most **3 focus cues** (`MAX_BRIEF_FOCUS`). Only focus and new skills
  become cues; improving ones are encouragement only.
- "Add as cue" puts a suggestion into the booking's teacher notes
  ([lesson notes](classes-lesson-content.md#lesson-notes)).
- No profile, no signal or no AI key → no brief, never an error.

## Vocabulary review (`VocabularyReview`)

SM-2 (`lib/lesson-notes/srs.ts`). Grades `again`, `hard`, `good`, `easy`.

- First review: `easy` → 4 days, otherwise 1 day.
- Second: `hard` → 1 day, otherwise 6 days.
- Later: `hard` × 1.2, otherwise × ease factor.
- `again` resets and re-shows the term in **10 minutes**.
- Ease defaults to **2.5** (`DEFAULT_EASE`), floor **1.3** (`MIN_EASE`).
- Seeding terms from the profile is idempotent; an in-progress term's schedule
  is never reset.

## What the student sees

- `LessonInsight`, `LessonPronunciation`, `LessonBrief` and the transcript are
  **teacher-only, always** — with one exception below: a confirmed vocabulary
  finding's summary becomes a flashcard term while progress is shared.
- The profile is teacher-only by default. Once **share progress** is on for
  the pairing (`TeacherStudent.shareProgress`, default off), the student sees a
  reframed view per teacher: skills as "improving" or "worth practising", with
  no evidence, category or trend labels. The teacher sets it for everyone at
  once on `/settings/booking-page` (`setProgressSharingAction`, which also sets
  `Teacher.shareProgressByDefault` for new pairings), or per student on the
  student page (Pro).
- **Vocabulary flashcards follow the same switch.** The queue is seeded from a
  shared profile's vocabulary list, and only terms from pairings that share
  progress _right now_ are shown (`dueVocabularyFor`,
  `lib/lesson-notes/student-progress.ts`). Turning sharing off hides that
  teacher's cards at once; turning it back on brings them back with their
  schedule intact. Grading is the student's own and stays scoped to her
  identities.
- **A card is the term and nothing else.** She recalls what it means and how
  to use it, then grades herself; there is no back to flip to. The term is the
  confirmed vocabulary finding's summary as the teacher left it — the one piece
  of an insight the student sees, and only while progress is shared.

Why the card has no back: the only text stored beside a term is the insight's
`evidence` and `suggestion`, and neither is written for her. The insights
prompt (`lib/lesson-notes/insights.ts`) writes the suggestion **to the
teacher, in the teacher's reading language** (`locale`, which need not be one
the student reads), as coaching ("drill _estar_ for states with her"). The
evidence quotes the student's words as spoken, which for a vocabulary finding
is usually the mistake, so showing it without the correction teaches the
error. A teacher reads those notes
believing them private. A learner-facing gloss would need its own field,
written for the student and confirmed by the teacher; until one exists the
card shows the term alone.

Held by `apps/web/tests/lesson-notes/student-flashcards.test.ts` (the page),
`apps/web/src/lib/lesson-notes/student-progress.test.ts` and
`apps/web/tests/components/control-names.test.tsx` (the card).

## Surfaces

- **Teacher, student page**: the **Learning profile** tab groups fluency and
  comprehension under how they speak, then other focus areas, followed by the
  vocabulary cloud. Rows show skill, category, trend and recurrence count;
  evidence is collapsed and cut to 80 characters (`lib/lesson-notes/profile-view.ts`).
  The teacher can add her own focus area, attached to the latest class that took
  place, and manage insights consent and progress sharing.
- **Teacher, during the call**: **Quick note** saves a one-line focus area for
  the current class (`source: "teacher"`, confirmed on creation).
- **Teacher, class page**: before the class, the brief; after it, findings by
  category with Confirm, Edit, Dismiss and "add your own"; the speaking-time
  card; and the replay page (`/dashboard/classes/[bookingId]/replay`) with the
  transcript.
- **Student**: "Your progress" and its vocabulary flashcards, both only while
  the pairing shares progress.
- **Admin** (`/admin/lesson-insights`, `superadmin`): stage counts and
  timestamps and stuck-capture detection — never content. A banner shows when
  the legacy audio transcription path is enabled.

## Error states

- Non-Pro teacher confirms, edits, dismisses, adds, records consent or toggles
  one student's sharing → upgrade nudge (HTTP 402 from a route handler).
- Another teacher's insight → not found; no write, no recompute.
- Empty summary on an edited or added insight → rejected.
- Pronunciation scoring skipped (not an error) when disabled, the language is
  unsupported, there is no reference text, or no vendor is configured.

## Permissions

| Action                                    | Owning teacher         | Student                          | Admin                      |
| ----------------------------------------- | ---------------------- | -------------------------------- | -------------------------- |
| View insights, profile, brief, transcript | Yes                    | No (reframed progress if shared) | Counts and timestamps only |
| Confirm / edit / dismiss / add an insight | Yes (Pro)              | No                               | No                         |
| Record or revoke insights consent         | Yes (Pro)              | No                               | No                         |
| Toggle share progress                     | Yes (per student: Pro) | No                               | No                         |
| Grade vocabulary review                   | —                      | Yes, own queue                   | No                         |

Server actions and route handlers call the same functions, so these rules
cannot drift between entry points.

## Open questions

- **Cancelled and no-show classes** are not special-cased; with no captions
  there is no transcript, but no test asserts it.
- **Transcript quality on learner speech is unmeasured.** Recognisers tend to
  tidy grammar, which is what the grammar category looks for; the
  teacher-confirm loop bounds the damage ([D-185](../decisions/D-185.md)).
- **The legacy audio path is dead code in production** — `LessonAudio`, the
  egress capture, the Deepgram batch adapter and the admin counts for it.
