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

- **The teacher's captions toggle is the trigger.** The transcript is the
  caption text the participants' browsers already produce. No captions, no
  transcript, no insights for that class.
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

1. While captions are on and the class's caption session carries
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

- **The transcript's language is always Spanish.** Every `LessonTranscript` is
  stamped `DEFAULT_LESSON_LANGUAGE` (`"es"`, `lib/transcription/config.ts`),
  and the brief and insights read it whatever the teacher teaches. It must come
  from the booking before a teacher of another language relies on insights.
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
  **teacher-only, always**.
- The profile is teacher-only by default. Once **share progress** is on for
  the pairing (`TeacherStudent.shareProgress`, default off), the student sees a
  reframed view per teacher: skills as "improving" or "worth practising", with
  no evidence, category or trend labels. The teacher sets it for everyone at
  once on `/settings/booking-page` (`setProgressSharingAction`, which also sets
  `Teacher.shareProgressByDefault` for new pairings), or per student on the
  student page (Pro).
- `VocabularyReview` is the student's own flashcard queue.

## Surfaces

- **Teacher, student page**: the profile card (focus areas by recurrence, ties
  favouring "focus"; skill, category, evidence, trend, count; vocabulary
  cloud), the consent controls with a minor checkbox, and the share-progress
  toggle.
- **Teacher, class page**: before the class, the brief; after it, findings by
  category with Confirm, Edit, Dismiss and "add your own"; the speaking-time
  card; and the replay page (`/dashboard/classes/[bookingId]/replay`) with the
  transcript.
- **Student**: "Your progress" (only if shared) and the vocabulary flashcards.
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
