# Live Calls & Video

## Overview

Every scheduled class has a corresponding live video call, joined by the
teacher and student from a per-booking room. Calls run on **self-hosted
LiveKit** (a single Oracle free-tier box also used by preview — see decision
D-94, 2026-07-21). On top of the core call
(mute/camera/screen-share/leave), the product layers three Pro-gated,
legal/consent-sensitive capabilities: **recording** (teacher-controlled A/V
capture of the whole class), **live captions** (real-time speech-to-text +
translation, one-way teacher→student on a scheduled class), and **post-call
transcription** (derived from separate per-participant audio, feeding a
downstream lesson-insights pipeline). All three were re-enabled in production by
D-94 after having initially been held back.

Source: `apps/web/src/lib/video/*`, `apps/web/src/lib/captions/*`,
`apps/web/src/lib/transcription/*`, `docs/decisions/D-94.md`,
`docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md`.

## User Stories

- As a **teacher or student**, I want to join my scheduled class's video call
  with one tap, reliably, without worrying about connection drops when I
  navigate elsewhere in the app.
- As a **teacher**, I want to record a class (Pro feature) so I have a
  reference of what was taught.
- As a **teacher**, I want live captions of what I'm saying translated for
  my student in real time, without either of us needing to set anything up
  mid-call.
- As a **teacher**, I want a transcript and pronunciation insight generated
  automatically after class, without having to remember to start anything —
  as long as my student has actually consented to being analyzed this way.
- As a **teacher or student**, I want to share my screen during a class
  (e.g. to show a document), and know only one side can share at a time.
- As a **teacher or student**, I want to nudge my counterpart if they haven't
  joined yet, without it feeling like a cold automated call.
- As a **student**, I want to be told plainly that a class may be recorded,
  and to have my voice specifically analyzed only when I've said yes.

## Business Rules (exhaustive)

### Joining / connection

1. One LiveKit room per class booking, named `class-<bookingId>`. A room name
   without that prefix resolves to no booking, so the recording/transcription
   handlers ignore it rather than mis-keying a class.
2. A join token is minted fresh on **every** server render of the call page
   (2-hour TTL) — this is deliberate, not wasteful: the client is built to
   **not** reconnect merely because the token value changed (only the media
   server URL and an explicit retry counter are watched for reconnect
   purposes). This was a real fix for a regression where tapping Record
   (which triggers a page re-render via `revalidatePath`) would otherwise
   tear down and reconnect the whole call.
3. The active call session lives in a React context mounted once at the app
   root, not tied to the call page's own component lifecycle — navigating to
   another screen (e.g. chat) does not hang up the call; this is what powers
   "minimize" behavior.
4. Starting a call session for a **different** booking while one is already
   active is refused outright — the product has no concept of two
   simultaneous calls; the user must leave the current one first. Starting
   the same booking again (e.g. returning to the page) simply refreshes the
   session with a new token.

### Call controls

5. Mic and camera can each be toggled independently by either party.
6. **Screen share**: either party can share, but only one side at a time —
   the option is disabled for whichever party is not already sharing while
   the other is (a 1:1 product, not a multi-presenter one). No system audio
   is captured during screen share.
7. **Nudge**: either party can send a one-click push notification to the other
   if they haven't joined a scheduled class yet. This is NOT an automatic ring
   at class start time — pushing that decision to a manual click was deliberate,
   because an automated ring on top of the existing reminder ladder would feel
   jarring. Rules: one nudge per (booking, recipient) per 45 seconds; refused
   with `already-present` if the counterparty (or anyone else) is already in the
   room when the nudge is attempted.
   ⚠️ It rode a transport that had been retired, which means it delivered
   **nothing** — while reporting "Sent" — for a month. It reads
   `web_push_subscriptions` now.
8. **Bookmark** (teacher-only): a one-tap marker of "this moment" during the
   call, for later review via a replay view.
9. Additional controls: leave/hang-up, minimize, picture-in-picture,
   camera-flip/swap, materials viewer, "go to chat" shortcut.

### Recording

10. **Teacher-only, Pro-gated** — there is no student-facing start/stop
    recording action anywhere in the product.
11. Starting a recording self-heals a stale prior recording first: if an
    earlier session's egress never got an explicit Stop (e.g. the teacher
    navigated away), the next Record attempt stops that dangling egress and
    marks it `completed` before starting a fresh one — a class is never
    silently blocked from recording by a leftover in-progress row.
12. **The A/V room-composite recording itself requires no per-student
    consent** — it proceeds unconditionally once the teacher (Pro-gated)
    taps Record. Consent only governs a **separate, additional** capability:
    per-participant "lesson-audio" capture that feeds the transcription/
    insights pipeline (see below). This is a load-bearing distinction: a
    student is recorded on video/audio as part of ordinary class recording
    whenever the teacher enables it, with no separate opt-in required for
    that specific layer.
13. Recording finalization is webhook-driven (`recording_ended`,
    `room_finished`), not client-driven, so a crashed app or an
    abruptly-closed tab never leaves a recording stuck in an unresolved
    state — a room-finished event sweeps any still-"recording" row
    automatically.
14. Storage: recordings land in R2 at `recordings/<bookingId>/<timestamp>.mp4`.

### Live captions

15. Provider: **Deepgram** (streaming ASR) for speech recognition,
    **Anthropic** (Claude) for translation of each finalized utterance.
16. On a **scheduled class**, captioning is **one-way only**: only the
    teacher's mic is captioned and translated (Spanish→English by default);
    the student receives, but does not need to enable, anything.
17. **Per-class language override**: `Booking.teacherLanguageOverride` /
    `studentLanguageOverride` — if the teacher has set a class-specific
    override, it wins over the teacher's/student's own profile default
    language. This is read live on every token-mint/translate call, **not
    snapshotted at booking creation** — a mid-day language change takes
    effect the next time either party's client mints a token or requests a
    translation, not retroactively for an already-open session.
18. Captions are **never persisted** — they're rendered ephemerally
    (a short rolling on-screen history, ~3 lines, each lingering a few
    seconds) and then gone; there is no caption transcript artifact separate
    from the post-call transcription pipeline below.
19. The teacher's caption toggle is hidden entirely if the flag is on but a
    required vendor key is missing — no error state, matching the
    "flag-on-but-dark" failure mode the product has hit before (the
    diagnostic logging that exists specifically for this was added _because_
    it happened silently once, at the Vercel→Fly cutover).

### Post-call transcription & lesson insights

20. Transcription is derived from **separate per-participant audio
    captures** (one file per speaker), **not** from the A/V room-composite
    recording — these are two independent capture pipelines with different
    retention rules.
21. Per-participant audio capture (and therefore transcription) for a given
    student's voice requires that **specific student's own recorded
    insights-consent** to exist. For a **minor student**, the student's own
    consent is explicitly **not sufficient by itself** — a guardian's consent
    must also be on file, or capture is skipped for that student entirely.
22. A missing teacher-student pairing record also blocks capture outright.
23. Once a speaker's audio file lands, it is transcribed and **merged** into
    one running per-booking transcript (each file's own relative timestamps
    are offset onto a single absolute timeline); once no participant's audio
    is still pending, the transcript is rebased to a clean timeline and a
    downstream "transcript ready" event fires for further analysis (lesson
    insights, pronunciation scoring).
24. **Retention**: raw per-speaker audio is deleted from storage after
    processing **unless** the teacher has explicitly opted in to audio
    retention (`Teacher.lessonAudioRetentionOptIn`) — the transcript itself
    is always kept; the source audio is derive-then-discard by default.
25. Not every call is transcribed — only when the transcription flag AND a
    configured ASR vendor key exist, AND the specific student's consent (or
    guardian consent, for a minor) is on file. No consent → no capture at
    all for that student, not merely a lesser-quality result.

### Materials on the call

26. **The teacher drives what the student looks at.** The in-call Materials
    control is teacher-only on both clients — she opens a material for
    herself, for the student, or for both, and the student has no independent
    way to pull one up mid-lesson. Both her class attachments and her whole
    library are reachable from that sheet.
27. Opening a material "for the student" or "for both" publishes it on
    LiveKit's reliable data channel, addressed to the student's participant
    identity. The whole material travels, not an id: a library item she
    hasn't attached to today's class would not resolve against the student's
    own list.
28. **What the call can show, it shows on the call.** Native content renders
    its Markdown, and a file attachment renders in the same viewer when it is
    a PDF (drawn page by page onto a canvas) or a raster image. Everything
    else — a .docx, a .zip, an .svg, an external link — opens in a browser
    tab, and its row in the picker says so before it is picked. Which bucket
    a file falls in is resolved server-side from its stored filename
    (`fileKind`), because there is no stored content type to ask.
29. **A material that can be shown in the call can be opened on the student's
    screen; one that cannot, cannot.** The "for me / for the student / for
    both" choice is offered for exactly the materials the viewer renders, so
    the teacher is never offered a share that would open a browser tab over
    the lesson on the student's device. That was the whole reason files were
    teacher-only until the viewer could draw them.
30. **The student never receives the answer key _in a content body_.**
    Whatever the teacher opens on the student's screen arrives with every
    `> [!answer]` callout cut out of the body, at any nesting depth, while
    the teacher's own copy keeps them behind the "Show answer" toggle. The
    cut is structural, not visual — see "Answer key visibility" in
    [`library-materials.md`](library-materials.md) for the rule and the
    boundaries that enforce it.
31. **A file carries no such guarantee, and nothing pretends otherwise.** A
    PDF is opaque bytes with no `> [!answer]` structure to cut, so a teacher
    who opens one on the student's screen shows her all of it — the same as
    sharing her screen. Answers she means to hold back belong in native
    content, where the cut is structural. A file only ever reaches the student
    through that one deliberate pick.
32. The student's in-call materials list is filtered twice over: by send
    timing (a not-yet-released material is absent) and by the answer-key cut
    above. Both follow from one `audience` parameter server-side, so a
    surface cannot get one and forget the other.

## User Flow

1. Teacher or student opens their upcoming class from their dashboard/class
   list; a "join call" affordance appears once the class window is near.
2. Joining mints a fresh LiveKit token server-side and connects to the room
   `class-<bookingId>`.
3. Both parties see each other's video tile, plus their own self-view; the
   floating self-view can be repositioned/minimized.
4. Either party can toggle mic/camera, share their screen (one at a time),
   or nudge the other if they haven't joined yet.
5. The teacher, if on Pro and the feature is enabled, can start recording;
   a recording indicator is shown while active, and Stop finalizes it.
6. The teacher, if captions are enabled, can toggle live captions; the
   student sees a translated scrolling caption of what the teacher says.
7. After the call ends (either party leaves, or the room otherwise
   finishes), any in-progress recording/audio-capture is finalized via
   webhook; consenting students' audio proceeds into the transcription
   pipeline; the teacher can later view class content/insights that surface
   from that pipeline.
8. Navigating away from the call screen to another part of the app (e.g.
   chat) keeps the call alive in the background (minimize), rather than
   hanging up.

## Data Used

- **CallRecording** — one row per A/V recording attempt: `bookingId`,
  `teacherId`, `egressId` (LiveKit egress handle), `storageKey` (R2 object
  path), `status` (`recording` → `completed`/`failed`), start/end times.
- **LessonAudio** — one row per participant per class, for the
  insights/transcription pipeline (audio-only, separate lifecycle from
  `CallRecording`): `speaker` (teacher/student), `egressId`, `storageKey`,
  `status` (`recording` → `ready` → `transcribed` → `deleted`), `durationMs`.
- **LessonTranscript** — one row per booking: merged, speaker-labelled,
  word-timestamped utterances, target language, ASR provider used
  (`deepgram` or `assemblyai`).
- **Booking.teacherLanguageOverride** / **studentLanguageOverride** —
  per-class caption-language overrides, live-read (not snapshotted).
- **Teacher.lessonAudioRetentionOptIn** — governs whether raw per-speaker
  audio is retained after transcription or discarded.
- Per-student insights consent (adult self-consent, or guardian consent for
  a minor) — gates whether that student's `LessonAudio` capture happens at
  all.

## Edge Cases

- Tapping Record mid-call does not cause a reconnect/black-screen — this was
  a real bug the token/connection-key design explicitly guards against.
- A prior recording session's egress never got stopped (app crash,
  navigate-away): the next Record tap self-heals it before starting fresh,
  rather than refusing to record or leaving two egresses running.
- A room finishes (call ends) with a recording still marked in-progress: a
  webhook-driven sweep finalizes it, regardless of how the call actually
  ended.
- Only one party ever joins the call: the product's answer is the Nudge
  button (with its cooldown/already-present guard), not any automatic
  fallback behavior or recording/consent rule.
- A student without insights consent is in a class the teacher records: the
  A/V recording proceeds normally; that student's voice is simply never
  captured into the separate lesson-audio/transcription pipeline.
- Mid-class language override change: takes effect on the next token
  mint/translate call, not instantly for an already-open caption session
  (a caption socket bakes in its language at connection time).
- Both parties try to screen-share near-simultaneously: whoever's toggle
  lands first wins; the other party's control is disabled while the first
  share is active.
- The browser refuses to play the other party's audio (iOS blocks playback
  until the page has made sound of its own, and blocks it again when a hidden
  tab comes back): the call surface says so and offers the tap that unblocks
  it — the message IS the button, because the browser only lifts the block
  inside a real user gesture. It clears on the room's own playback status,
  never optimistically, so it cannot dismiss itself over a call that is still
  silent.

## Error States

- Missing/misconfigured video provider credentials: `getVideoProvider()`
  returns null and every caller degrades gracefully (feature hidden) rather
  than throwing.
- Missing caption vendor keys with the caption flag on: the caption toggle
  is simply hidden — no error surfaced to the user, only a one-time internal
  diagnostic log.
- Recording attempted by a non-Pro teacher: blocked by the Pro-plan gate.
- Recording attempted by anyone but the class's own teacher: blocked by
  teacher-tenancy check on the booking.
- Nudge attempted more than once within 45 seconds for the same recipient:
  refused (cooldown).
- Nudge attempted when the recipient (or anyone) is already in the room:
  refused (`already-present`).
- A browser's refusal to play audio is not an application error and is never
  reported as one: it is room state (LiveKit's own playback status) driving a
  visible, tappable row, not an exception. The library's internal retries of
  that unblock are prevented from escaping as unhandled rejections, which is
  the only form this failure used to take.

## Permissions

| Action                          | Class's teacher              | Class's student                    | Other user |
| ------------------------------- | ---------------------------- | ---------------------------------- | ---------- |
| Join call                       | Yes                          | Yes                                | No         |
| Mute/camera toggle              | Yes (own)                    | Yes (own)                          | No         |
| Screen share                    | Yes (if other isn't sharing) | Yes (if other isn't sharing)       | No         |
| Start/stop recording            | Yes (Pro only)               | No                                 | No         |
| Toggle live captions            | Yes                          | No (receive-only)                  | No         |
| Set per-class language override | Yes                          | No                                 | No         |
| Send a nudge                    | Yes                          | Yes                                | No         |
| Bookmark a moment               | Yes                          | No                                 | No         |
| View transcript/lesson insights | Yes (own class)              | Not confirmed — see Open Questions | No         |

## Open Questions

- **Decision-doc numbering discrepancy**: the LiveKit self-host cutover +
  legal-gate override (PR #670, 2026-07-21) is filed under **D-94**. A
  short-lived numbering collision meant some contemporaneous notes filed the
  same change under a different number; D-94 is authoritative.
- **Production LiveKit connectivity cannot be confirmed from the repo.**
  `docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md` documents an outstanding manual
  step (production's `LIVEKIT_API_SECRET` possibly not yet matching the
  self-hosted box) as of D-94's writing, with no later decision doc found
  confirming it was resolved. If unresolved, production calls would fail to
  connect outright rather than merely degrade. Verify live before treating
  video calls as fully operational in production.
- **Vendor keys for captions/transcription (`DEEPGRAM_API_KEY`,
  `ANTHROPIC_API_KEY`, or `ASSEMBLYAI_API_KEY`) cannot be confirmed present
  in production from this repo** — the runtime env files explicitly instruct
  verifying via `fly secrets list --app agendaprofe` rather than assuming.
  The feature flags (`LIVE_CAPTIONS_ENABLED`, `CLASS_RECORDING_ENABLED`,
  `LESSON_INSIGHTS_TRANSCRIPTION_ENABLED`) are confirmed ON in production
  per D-94, but "flag on" has already once meant "silently dark" in this
  product's history (the Vercel→Fly cutover incident) — do not treat flag
  state alone as proof the feature works end-to-end for real users.
- **`LIVE_CAPTIONS_ENABLED` is off on preview but on in production** — the
  repo has a brief inline note that it's "turned off on preview" but no
  fuller reasoning was found; confirm whether this is intentional
  environment-specific behavior or an oversight.
- **The teacher-facing surface that displays `LessonTranscript` /
  transcription output to a teacher** (presumably a "lesson insights" or
  "lesson notes" screen) was not directly located/verified in this research
  pass — confirm the actual UI before writing QA cases against "teacher can
  view the transcript."
- Whether a **student** can ever view their own class transcript/insights
  (as opposed to only the teacher) was not confirmed either way.
