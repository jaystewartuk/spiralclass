import {
  assignRecognizers,
  buildCaptionLine,
  splitUtterance,
  type CallRole,
  type CaptionLine,
  type CaptionSession,
} from "@spiralclass/shared";
import { CaptionTranslator, type TranslationRefusal } from "@/lib/captions/caption-translator";
import {
  CloudRecognizer,
  type CloudRecognizerOptions,
  type MediaRecorderCtorLike,
  type WebSocketCtorLike,
} from "@/lib/captions/cloud-recognizer";
import {
  TrackRecognizer,
  type RecognizerOptions,
  type RecognizerStopReason,
  type SpeechRecognitionCtorLike,
  type TranslatorApiLike,
} from "@/lib/captions/recognizer";

// The part of browser captions that decides what runs (D-185). Given the
// class's caption session, the teacher's switch and the room as it stands,
// it computes which speakers THIS browser must recognise
// (assignRecognizers, shared with the other participant's browser, so the
// two agree without talking) and reconciles running recognisers to match:
// starting, stopping, or restarting one when its track or language changes.
//
// A speaker no browser in the room can recognise (two phones) is assigned
// "cloud": their OWN browser streams their microphone to the paid
// speech-to-text fallback (cloud-recognizer.ts) and publishes the result like
// any line of its own speaker's. The other browser runs nothing for them.
//
// Each finished utterance is split to the route's size, translated, built
// into a CaptionLine, and then either PUBLISHED to the other participant —
// when it is this browser's own speaker's speech — or SHOWN here, when this
// browser recognised the other person because their device cannot and this
// viewer is the one reading it. Lines per speaker keep their spoken order even
// though translations resolve at different speeds.
//
// When the session says the class's transcript is being kept (D-189:
// `transcriptCapture`, the flag plus this pairing's insights consent), each
// piece is also handed to `keep` — source text, speaker, and this browser's
// estimate of how long it took to say — BEFORE translation, so the transcript
// never depends on a translation succeeding. The recogniser that produced a
// line is the only one that keeps it, so a line reaches the server once.
//
// No React and no livekit-client here: the hook (use-browser-captions.ts)
// feeds it plain values, which is what makes it testable against fakes.

export type CaptionRoomView = {
  localIdentity: string;
  localMicTrack: MediaStreamTrack | null;
  // The other participant, when present. `capable` is their published
  // CAPTIONS_RECOGNIZER_ATTRIBUTE.
  remote: { identity: string; micTrack: MediaStreamTrack | null; capable: boolean } | null;
};

export type BrowserCaptionsInput = {
  // Null until the config route answers, and when it answers "off".
  session: CaptionSession | null;
  // The teacher's switch, as this browser sees it.
  captionsOn: boolean;
  // Whether this browser can recognise during a call (canRecognizeDuringCall).
  selfCapable: boolean;
  room: CaptionRoomView;
};

export type BrowserCaptionsStatus = {
  // Speakers nobody in this room can caption right now, although captions are
  // on and they may be captioned — the view explains why. Empty for two
  // phones whenever the cloud fallback is configured.
  uncaptioned: CallRole[];
  // Set when a recogniser here gave up for good (microphone permission, a
  // language this browser cannot recognise, or the cloud fallback
  // unreachable).
  stopped: RecognizerStopReason | null;
};

// One recognised line to keep as part of the class's transcript (D-189).
export type KeptLine = {
  bookingId: string;
  speaker: CallRole;
  // The source text, verbatim — never the translation.
  text: string;
  // How long this piece took to say, estimated as the gap since the same
  // speaker's previous line (capped), shared across a split utterance's
  // pieces by length.
  durationMs: number;
};

// A recogniser can hold a final back, and a first line after a long silence
// would otherwise claim the silence as speech.
export const MAX_KEPT_LINE_MS = 60_000;

export type BrowserCaptionsDeps = {
  SpeechRecognition: SpeechRecognitionCtorLike | null;
  Translator: TranslatorApiLike | null;
  // What the cloud fallback records and streams with; null where absent.
  WebSocket: WebSocketCtorLike | null;
  MediaRecorder: MediaRecorderCtorLike | null;
  fetch: typeof fetch;
  // Send a line to the other participant (its `for`).
  publish: (line: CaptionLine) => Promise<void>;
  // Show a line to this viewer.
  showLocal: (line: CaptionLine) => void;
  // Keep a line as part of the class's transcript (D-189). Only called while
  // the session's `transcriptCapture` is true.
  keep: (line: KeptLine) => void;
  onStatus: (status: BrowserCaptionsStatus) => void;
  // The server refused a translation for a reason retrying cannot fix; the
  // hook re-reads the config, which re-runs the assignment.
  onRefused: (reason: TranslationRefusal) => void;
  now?: () => number;
  createRecognizer?: (options: RecognizerOptions) => { start(): void; stop(): void };
  createCloudRecognizer?: (options: CloudRecognizerOptions) => { start(): void; stop(): void };
};

type Running = {
  key: string;
  recognizer: { start(): void; stop(): void };
  // Serialises this speaker's lines so they are shown in the order spoken.
  chain: Promise<void>;
  // When this speaker's previous line finished (or the recogniser started):
  // the base for the next line's duration estimate.
  lastFinalAt: number;
};

const SPEAKERS: readonly CallRole[] = ["teacher", "student"];

export class BrowserCaptions {
  private readonly running = new Map<CallRole, Running>();
  // Keys of recognisers that gave up for good; not restarted by a later sync
  // for the same track and language, which would fail the same way.
  private readonly givenUp = new Set<string>();
  private stopped: RecognizerStopReason | null = null;
  private seq = 0;
  private lastStatus = "";
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: BrowserCaptionsDeps) {
    this.now = deps.now ?? Date.now;
  }

  sync(input: BrowserCaptionsInput): void {
    if (this.disposed) return;
    const { session, room } = input;
    const desired = new Map<CallRole, { key: string; start: () => Running }>();
    let uncaptioned: CallRole[] = [];

    if (session && input.captionsOn) {
      const me = session.role;
      const other: CallRole = me === "teacher" ? "student" : "teacher";
      const present = { [me]: true, [other]: room.remote !== null } as Record<CallRole, boolean>;
      const capable = {
        [me]: input.selfCapable,
        [other]: room.remote?.capable ?? false,
      } as Record<CallRole, boolean>;
      const assignment = assignRecognizers({
        captionsOn: true,
        teacher: { present: present.teacher, capable: capable.teacher },
        student: { present: present.student, capable: capable.student },
        studentConsent: session.studentConsent,
        cloudAvailable: session.cloudRecognition,
      });
      uncaptioned = SPEAKERS.filter(
        (s) =>
          assignment[s] === null &&
          room.remote !== null &&
          (s === "teacher" || session.studentConsent),
      );

      for (const speaker of SPEAKERS) {
        if (!room.remote) continue;
        const mine = speaker === me;
        // This browser's recognisers: the ones assigned to its role, and the
        // cloud stream for its own speaker. A browser recogniser needs the
        // Web Speech API; the cloud one checks its own APIs when it starts.
        const kind =
          assignment[speaker] === me && this.deps.SpeechRecognition
            ? "browser"
            : assignment[speaker] === "cloud" && mine
              ? "cloud"
              : null;
        if (!kind) continue;
        const track = mine ? room.localMicTrack : room.remote.micTrack;
        if (!track || track.readyState === "ended") continue;
        const direction = session.directions[speaker];
        const lang = session.recognitionLocales[speaker];
        const speakerIdentity = mine ? room.localIdentity : room.remote.identity;
        const listenerIdentity = mine ? room.remote.identity : room.localIdentity;
        const key = [
          kind,
          session.bookingId,
          speaker,
          track.id,
          lang,
          direction.source,
          direction.target,
          speakerIdentity,
          listenerIdentity,
        ].join("|");
        if (this.givenUp.has(key)) continue;
        desired.set(speaker, {
          key,
          start: () =>
            this.startSpeaker({
              key,
              kind,
              speaker,
              track,
              lang,
              session,
              direction,
              speakerIdentity,
              listenerIdentity,
              publish: mine,
            }),
        });
      }
    }

    for (const [speaker, run] of this.running) {
      if (desired.get(speaker)?.key !== run.key) {
        run.recognizer.stop();
        this.running.delete(speaker);
      }
    }
    for (const [speaker, want] of desired) {
      if (!this.running.has(speaker)) this.running.set(speaker, want.start());
    }
    this.report({ uncaptioned, stopped: this.stopped });
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.running.values()) run.recognizer.stop();
    this.running.clear();
  }

  private startSpeaker(args: {
    key: string;
    kind: "browser" | "cloud";
    speaker: CallRole;
    track: MediaStreamTrack;
    lang: string;
    session: CaptionSession;
    direction: { source: string; target: string };
    speakerIdentity: string;
    listenerIdentity: string;
    publish: boolean;
  }): Running {
    const translator = new CaptionTranslator({
      bookingId: args.session.bookingId,
      speaker: args.speaker,
      source: args.direction.source,
      target: args.direction.target,
      Translator: this.deps.Translator,
      fetch: this.deps.fetch,
      onRefused: (reason) => this.deps.onRefused(reason),
      now: this.now,
    });
    const run: Running = {
      key: args.key,
      chain: Promise.resolve(),
      recognizer: { start() {}, stop() {} },
      lastFinalAt: this.now(),
    };
    const onFinal = (text: string) => {
      const at = this.now();
      const durationMs = Math.min(Math.max(0, at - run.lastFinalAt), MAX_KEPT_LINE_MS);
      run.lastFinalAt = at;
      if (args.session.transcriptCapture) this.keep(text, durationMs, args);
      run.chain = run.chain.then(() => this.deliver(text, translator, args)).catch(() => {});
    };
    const onStopped = (reason: RecognizerStopReason) => {
      this.givenUp.add(args.key);
      if (this.running.get(args.speaker) === run) this.running.delete(args.speaker);
      this.stopped = reason;
      this.report({ uncaptioned: [], stopped: reason });
    };
    if (args.kind === "cloud") {
      const create =
        this.deps.createCloudRecognizer ?? ((o: CloudRecognizerOptions) => new CloudRecognizer(o));
      run.recognizer = create({
        bookingId: args.session.bookingId,
        track: args.track,
        fetch: this.deps.fetch,
        WebSocket: this.deps.WebSocket,
        MediaRecorder: this.deps.MediaRecorder,
        onFinal,
        onStopped,
        onRefused: (reason) => this.deps.onRefused(reason),
      });
    } else {
      const create =
        this.deps.createRecognizer ?? ((o: RecognizerOptions) => new TrackRecognizer(o));
      run.recognizer = create({
        Ctor: this.deps.SpeechRecognition as SpeechRecognitionCtorLike,
        track: args.track,
        lang: args.lang,
        onFinal,
        onStopped,
      });
    }
    run.recognizer.start();
    return run;
  }

  // Hand a finished utterance to the transcript, piece by piece, with the
  // duration shared out by length so the pieces' timings still add up.
  private keep(
    text: string,
    durationMs: number,
    args: { session: CaptionSession; speaker: CallRole },
  ): void {
    const pieces = splitUtterance(text);
    const total = pieces.reduce((n, p) => n + p.length, 0);
    for (const piece of pieces) {
      this.deps.keep({
        bookingId: args.session.bookingId,
        speaker: args.speaker,
        text: piece,
        durationMs: total > 0 ? Math.round((durationMs * piece.length) / total) : 0,
      });
    }
  }

  private async deliver(
    text: string,
    translator: CaptionTranslator,
    args: {
      direction: { source: string; target: string };
      speakerIdentity: string;
      listenerIdentity: string;
      publish: boolean;
    },
  ): Promise<void> {
    for (const piece of splitUtterance(text)) {
      const translated = await translator.translate(piece);
      if (translated === null || this.disposed) continue;
      const line = buildCaptionLine({
        translated,
        source: piece,
        sourceLanguage: args.direction.source,
        targetLanguage: args.direction.target,
        speakerIdentity: args.speakerIdentity,
        listenerIdentity: args.listenerIdentity,
        seq: this.seq++,
        now: this.now(),
      });
      if (args.publish) await this.deps.publish(line);
      else this.deps.showLocal(line);
    }
  }

  // Only when something changed, so a sync on every room event does not
  // re-render the call on every event.
  private report(status: BrowserCaptionsStatus): void {
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.deps.onStatus(status);
  }
}
