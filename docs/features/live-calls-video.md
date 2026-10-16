# Live Calls & Video

Every scheduled class has a corresponding live video call, joined by the
teacher and student from a per-booking room. Calls run on **self-hosted
LiveKit** at `livekit.spiralclass.com`: one free Compute Engine `e2-micro`
running `livekit-server` and Caddy, with no egress —
[D-16](../decisions/D-16.md), [`infra/gcp-livekit/`](../../infra/gcp-livekit/README.md).
It carries one class at a time comfortably; a second overlapping class is the
trigger for a bigger machine. **Preview has no video** (see
[Joining and connection](#joining-and-connection)). On top of the core call (mute/camera/screen-share/leave),
the product layers three Pro-gated, legal/consent-sensitive capabilities:
**recording** (teacher-controlled capture of the whole class, audio-only), **live captions** (real-time speech-to-text + translation of both
people, run in their browsers — [D-185](../decisions/D-185.md)), and the
**lesson transcript** (the caption lines, kept with the student's insights
consent as the class's transcript for the lesson-insights pipeline —
[D-185](../decisions/D-185.md)). **Captions and the transcript are on in
production; recording is off**: it needs egress, which the box cannot carry,
so D-16 switched it off. The behaviour below is what each does when on.

Code: `apps/web/src/lib/video/`, `apps/web/src/lib/captions/`,
`apps/web/src/lib/transcription/`, `apps/web/src/components/video/`.

## Business rules

### Joining and connection

1. One LiveKit room per class booking, named `class-<bookingId>`. A room name
   without that prefix resolves to no booking, so the recording/transcription
   handlers ignore it rather than mis-keying a class.
2. A join token is minted fresh on **every** server render of the call page
   (2-hour TTL) — this is deliberate, not wasteful: the client is built to
   **not** reconnect merely because the token value changed (only the media
   server URL and an explicit retry counter are watched for reconnect
   purposes), so a re-render — tapping Record revalidates the page — never
   tears down the call.
   - **Nothing connects before a Join tap.** Opening the call shows a check
     first: a camera preview, a live microphone bar, a camera and microphone
     picker where there is more than one, and on/off toggles. A blocked
     permission, a missing device or one another app holds is explained
     there, and joining without media is always possible. The call then
     starts with exactly what was left on, on the devices picked. A Retry
     after a failed connect does not ask again. In the call, the microphone
     button carries a ring while the person's own voice is coming through.
3. The active call session lives in a React context mounted once at the app
   root, not tied to the call page's own component lifecycle — navigating to
   another screen (e.g. chat) does not hang up the call; this is what powers
   "minimize" behavior.
4. Starting a call session for a **different** booking while one is already
   active is refused outright — the product has no concept of two
   simultaneous calls; the user must leave the current one first. Starting
   the same booking again (e.g. returning to the page) simply refreshes the
   session with a new token.

**Preview has no video.** Preview holds no LiveKit key pair
([D-16](../decisions/D-16.md), `config/env/preview.runtime.env`), so
`getVideoProvider()` returns null there. Both call pages on preview show "Video calling isn't
switched on yet", the student's class page shows no join button, and recording,
live captions and post-call transcription cannot run there, whatever
`config/env/preview.runtime.env`'s flags say. Only production runs a real call.

### Call controls

5. Mic and camera can each be toggled independently by either party.
6. **Screen share**: either party can share, but only one side at a time —
   the option is disabled for whichever party is not already sharing while
   the other is (a 1:1 product, not a multi-presenter one). No system audio
   is captured during screen share.
7. **Nudge**: either party can send a one-click push notification to the other
   if they haven't joined a scheduled class yet. It is **not** an automatic ring
   at class start: on top of the reminder ladder an automated ring would feel
   jarring. One nudge per (booking, recipient) per 45 seconds
   (`NUDGE_COOLDOWN_MS`, `lib/video/nudge.ts`); refused with `already-present`
   if anyone is already in the room. It is delivered by Web Push
   (`web_push_subscriptions`).
8. **Bookmark** (teacher-only): a one-tap marker of "this moment" during the
   call, for later review via a replay view. A bookmark is a `LessonNote` with
   `kind: "bookmark"`, excluded from every ordinary notes surface (the notes
   panel, the live cue overlay, the AI summary's source, copy-from-last-class).
   Its jump point is **never stored**: it is derived at read time as
   `createdAt` minus the earliest `LessonAudio.startedAt` for the booking, the
   same 0-basis the legacy transcript timeline uses
   (`lib/lesson-notes/bookmarks.ts`). Do not add a stored offset. A class with
   no `LessonAudio` row — every class while recording is off, since the
   browser-written transcript captures no audio — gives its bookmarks no jump
   point.
9. Additional controls: leave/hang-up, minimize, picture-in-picture,
   camera-flip/swap, materials viewer, "go to chat" shortcut.
   - On a phone (below `sm`) the row is icons only and keeps microphone,
     camera, captions, materials and leave; the rest (flip camera, message,
     screen share, record, bookmark) sit behind **More**, so the row is one
     line instead of a third of the screen.
   - **The top bar**, a row above the stage that never covers it: each
     side's notes on the left (collapsible), the other person's name and the
     **lesson clock** in the middle ("Starts in 3 min", "23 min left", "4 min
     over" — warning-coloured from the last five minutes), minimise and
     pop-out on the right. Status messages float just below it over a video,
     and take a row of their own while a material or screen share fills the
     stage, so nothing sits on top of the material's title or first lines.
   - **A camera that is off is not a black screen.** The other person's tile
     shows their initials and name, a badge while their microphone is off,
     and a ring while they are speaking — on the stage and in the corner
     tile.

### Recording

10. **Teacher-only, Pro-gated** — there is no student-facing start/stop
    recording action anywhere in the product.
11. Starting a recording self-heals a stale prior recording first: if an
    earlier session's egress never got an explicit Stop (e.g. the teacher
    navigated away), the next Record attempt stops that dangling egress and
    marks it `completed` before starting a fresh one — a class is never
    silently blocked from recording by a leftover in-progress row.
12. **The room-composite recording requires no per-student consent** — it
    starts once the teacher (Pro) taps Record. Insights consent governs only
    what is kept for lesson insights: the caption transcript, and on the
    dormant legacy path the per-speaker `LessonAudio` capture. A student is
    recorded whenever the teacher records, with no separate opt-in for that.
13. Recording finalization is webhook-driven (`recording_ended`,
    `room_finished`), not client-driven, so a crashed app or an
    abruptly-closed tab never leaves a recording stuck in an unresolved
    state — a room-finished event sweeps any still-"recording" row
    automatically.
14. Storage: recordings land in R2 at `recordings/<bookingId>/<timestamp>.m4a`
    (`callRecordingKey`, `lib/video/recording.ts`). The room composite is
    **audio-only** (MP4/AAC, [D-16](../decisions/D-16.md)); older `.mp4` rows
    are video and still play, because the key's extension is what the replay
    page reads to choose its player.
    - **Auto-record** (`Teacher.autoRecordClasses`, Settings → Account,
      default off; the card is hidden unless recording is enabled): the server
      starts the recording on `participant_joined` once **both** the teacher
      and the student are in the room, and only if the booking has **no**
      `CallRecording` row at all, so a teacher's Stop is never undone by a
      reconnect. It reuses `startBookingRecording`, so the Pro gate applies,
      and it never touches the student's insights consent. Both parties see
      the recording indicator either way.

### Live captions

15. **Captions run in the participants' browsers**
    ([D-185](../decisions/D-185.md)). Speech is recognised by the browser's own
    speech recognition — on the device when the browser has the model for that
    language, otherwise by the browser's speech service (Google, for Chrome) —
    and each finished utterance is translated on the device when the browser
    has a translator for the pair (desktop Chrome), otherwise by
    `POST /api/captions/translate` through Google Cloud Translation.
    **The words are on screen while they are being said**
    ([D-185](../decisions/D-185.md)): what the recogniser has heard of the
    phrase in progress goes to the listener at once, untranslated, and the
    finished, translated line replaces it when the phrase ends. Only finished
    utterances are translated or kept for the transcript, and a translation
    that takes longer than 6 seconds is dropped. There is no server-side captions process: the one paid path
    (below) streams from a participant's own browser to Deepgram.
    - **Who recognises whom.** Each person's speech is recognised by their
      own browser when it can recognise during a call — today that means
      Chrome on a computer. When it cannot (Android Chrome measurably hears
      nothing while the call holds the microphone), the **other** person's
      browser recognises it from the call audio it already receives. Both
      browsers compute this from the same room state (each publishes whether
      it can, as a participant attribute), so they agree without talking.
    - **When neither browser can — two phones.** Each person's own browser
      records their call microphone track and streams it to Deepgram
      (Nova-3, with interim results for the words in progress, opted out of
      Deepgram's model training), and the
      transcript goes through the same translate-and-publish path. This is
      the only case that uses it: never for a speaker a browser in the room
      can recognise, never for the student without her consent. Each
      connection starts at `POST /api/captions/stt-token`, which re-runs the
      caption access and consent checks, reads the room from LiveKit's server
      to confirm no participant says it can recognise and the teacher's
      switch is on, then returns a 30-second Deepgram token and the listen
      URL — the server picks the model and language, and the long-lived key
      never reaches the browser. Grants are rate-limited per caller per class
      and per class per day, and each is logged. Without `DEEPGRAM_API_KEY`
      the fallback is off and two phones are told captions need one of them
      on Chrome on a computer, as before.
    - A line one browser recognises for its own speaker is published to the
      other participant over LiveKit's reliable data channel, addressed to
      them. A line a browser recognises from the other person is shown on
      that browser only — its viewer is the reader.
    - On-device models download on the teacher's click of the toggle (the
      browser refuses the download without one); until then, and on any
      browser without a translator, lines go through the server.
16. **Both directions are captioned, behind one switch.** The teacher's
    toggle is the room's single switch (D-185, teacher-toggled) and covers
    both people. The teacher's speech is translated into the student's
    language and needs no consent record; the **student's speech is captioned
    only with her recorded captions consent** (her guardian's, for a minor —
    D-22), whichever browser would recognise it, and
    `/api/captions/translate` refuses her speech without it. A student
    without consent still receives captions of the teacher.
    - **The consent is asked for where it matters.** While captions are on
      and an adult student has not consented, her call screen asks her —
      "Turn on" records her own consent (the same self-service write as her
      account page's toggle, across all her teachers) and captioning of her
      speech starts within seconds; "Not now" lasts for that call. The
      teacher's screen says her student's speech is not captioned yet and
      that she is being asked; for a minor, it says the guardian's consent is
      the one to record, and the student is never asked to consent for
      herself. The teacher's student page shows each consent under its own
      heading, including whether an adult has turned captions on.
17. **Per-class language override**: `Booking.teacherLanguageOverride` /
    `studentLanguageOverride` — if the teacher has set a class-specific
    override, it wins over the teacher's/student's own profile default
    language. It is read live, **not snapshotted at booking creation**: both
    browsers re-read the class's caption config every minute while captions
    are on, and the translation route resolves the languages from the
    booking on every call — the client never names a language. The teacher's
    speech is recognised in her country's regional variant when that is a
    real one (`es` + Mexico → `es-MX`), the student's in the bare language.
18. Captions are **never persisted** — they're rendered ephemerally
    (a short rolling on-screen history, ~3 lines, each lingering a few
    seconds) and then gone; the in-call transcript panel lives in the
    browser's memory and goes when the viewer leaves. There is no caption
    transcript artifact separate from the post-call transcription pipeline
    below. The translation route logs a character count per call, never text;
    the token route logs each grant, never audio or the token.
    - **Captions are readable whatever is on the stage.** Over a camera they
      are a band along the bottom of the video. While a material or a screen
      share fills the stage they are a strip of their own beneath it — the
      content gives up that height rather than being covered — and the strip
      holds its height between sentences so a worksheet does not reflow as
      people speak. The transcript opens from either. (`resolveCaptionPlacement`
      in `apps/web/src/lib/video/stage-layout.ts`.)
    - **Each reader can put them away, on her own screen only, in two
      scopes.** Hiding them over a camera hides them everywhere. Hiding them
      under a material hides them only while a material or screen share is
      up: they return over the camera, a chip where the strip was brings them
      back, and the choice is remembered in that browser. Neither touches the
      room's switch, the other person's screen or the transcript. Whenever a
      reader has hidden them, the way back is on screen
      (`toggleCaptionsHerePatch` in `apps/web/src/lib/captions/preferences.ts`).
19. The teacher's caption toggle is hidden entirely if `LIVE_CAPTIONS_ENABLED`
    is on but `GOOGLE_TRANSLATE_API_KEY` is missing — no error state, only a
    one-time diagnostic log, because a flag that is on can still be dark. Both
    caption routes re-check the flag, the key, the class's participants and the
    teacher's Pro plan on every call.

### The lesson transcript

20. The transcript is the **caption text** (D-185): while captions are on,
    the browser that recognised a finished utterance also posts its source
    text, speaker and estimated duration to `POST /api/captions/transcript`.
    It is **not** derived from the A/V recording and **no audio is captured**
    for it.
21. A class's lines are kept only when its caption session says
    `transcriptCapture`: the transcription flag is on AND that **specific
    student's recorded insights consent** exists. For a **minor student**, the
    student's own consent is explicitly **not sufficient by itself** — a
    guardian's consent must be on file. A class for two also needs the buyer's
    confirmation for the second person (D-149). The route re-checks this per
    line; without it, nothing of either speaker is kept.
22. A missing teacher-student pairing record blocks keeping outright.
23. Lines are appended atomically to one per-booking `LessonTranscript`
    (provider `browser-live`), stamped at receipt. On the LiveKit
    `room_finished` webhook — or an Inngest fallback 30 minutes after the
    scheduled end — the transcript is rebased to a 0-based timeline, marked
    `browser`, and "transcript ready" fires for lesson insights. A line that
    arrives after that is dropped.
24. **Both participants are told "Learning notes are on"** each time lines
    start being kept, and see a small notes icon beside the lesson clock for
    as long as they are; tapping it says what is kept (caption text, no
    audio) and links to the privacy notice (D-22). The transcript is kept while the teacher's
    account is open and deleted with it.
25. Not every call gets a transcript — only when captions are on, the flag is
    on, and the consent above is on file. The legacy egress-audio path
    (`lib/transcription/pipeline.ts`) additionally requires recording to be
    enabled, so it is dormant. What happens to the transcript next is
    [lesson insights](lesson-insights-reports.md).

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

## User flow

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
   student sees a translated scrolling caption of what the teacher says, and
   the teacher sees one of what the student says if she has consented.
7. After the call ends (either party leaves, or the room otherwise
   finishes), any in-progress recording is finalized via webhook and a kept
   transcript is finalized for lesson insights. The teacher reviews the
   recording and transcript on the class's replay page
   (`/dashboard/classes/[bookingId]/replay`).
8. Navigating away from the call screen to another part of the app (e.g.
   chat) keeps the call alive in the background (minimize), rather than
   hanging up.

## Data used

- **CallRecording** — one row per A/V recording attempt: `bookingId`,
  `teacherId`, `egressId` (LiveKit egress handle), `storageKey` (R2 object
  path), `status` (`recording` → `completed`/`failed`), start/end times.
- **LessonAudio** — one row per participant per class, for the
  insights/transcription pipeline (audio-only, separate lifecycle from
  `CallRecording`): `speaker` (teacher/student), `egressId`, `storageKey`,
  `status` (`recording` → `ready` → `transcribed` → `deleted`), `durationMs`.
- **LessonTranscript** — one row per booking: merged, speaker-labelled,
  timestamped utterances, language, and provider — `browser-live` while lines
  are arriving, `browser` once finalized; `deepgram` or `assemblyai` on the
  legacy audio path.
- **Booking.teacherLanguageOverride** / **studentLanguageOverride** —
  per-class caption-language overrides, live-read (not snapshotted).
- **Teacher.lessonAudioRetentionOptIn** — governs whether raw per-speaker
  audio is retained after transcription or discarded.
- Per-student insights consent (adult self-consent, or guardian consent for
  a minor) — gates whether the transcript is kept at all.

## Edge cases

- Tapping Record mid-call does not reconnect the call (rule 2).
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
  recording proceeds normally; nothing of hers is kept as transcript.
- Mid-class language override change: takes effect within a minute, at the
  next caption-config read; the recogniser restarts in the new language.
- Both people on phones: nothing can be captioned in the browser, and both
  screens say so rather than showing a band that listens forever.
- A browser whose microphone permission is refused, or that cannot recognise
  the class's language: its recogniser stops for good and its screen says
  captions stopped on this device.
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

## Error states

- Missing/misconfigured video provider credentials: `getVideoProvider()`
  returns null and every caller degrades gracefully (feature hidden) rather
  than throwing.
- `GOOGLE_TRANSLATE_API_KEY` missing with the caption flag on: the caption
  toggle is simply hidden — no error surfaced to the user, only a one-time
  internal diagnostic log.
- A translation the server cannot produce (Google refused or was down, or
  the class's character budget is spent): that line is dropped, never shown
  untranslated, and captioning carries on with the next one.
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
  that unblock are kept from escaping as unhandled rejections.

## Permissions

| Action                          | Class's teacher              | Class's student                       | Other user |
| ------------------------------- | ---------------------------- | ------------------------------------- | ---------- |
| Join call                       | Yes                          | Yes                                   | No         |
| Mute/camera toggle              | Yes (own)                    | Yes (own)                             | No         |
| Screen share                    | Yes (if other isn't sharing) | Yes (if other isn't sharing)          | No         |
| Start/stop recording            | Yes (Pro only)               | No                                    | No         |
| Toggle live captions            | Yes                          | No (receives; captioned if consented) | No         |
| Set per-class language override | Yes                          | No                                    | No         |
| Send a nudge                    | Yes                          | Yes                                   | No         |
| Bookmark a moment               | Yes                          | No                                    | No         |
| View transcript/lesson insights | Yes (own class)              | No                                    | No         |

## Open questions

- **Production LiveKit connectivity cannot be confirmed from the repo.**
  [D-16](../decisions/D-16.md) names the first class booked and joined through
  the app after the Compute Engine box's deploy as the check; nothing in the
  tree records that class. If the key pair in production's secrets is not the
  box's own, calls fail to connect outright.
- **Vendor keys** (`GOOGLE_TRANSLATE_API_KEY`, `DEEPGRAM_API_KEY`,
  `ANTHROPIC_API_KEY`) cannot be confirmed present in production from the repo
  — check Infisical `production`, which `infra/gcp/push-cloudrun-env.sh` writes
  into the running service. A flag that is on is not proof the feature works.
