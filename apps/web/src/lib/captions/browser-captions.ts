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
// Each finished utterance is split to the route's size, translated, built
// into a CaptionLine, and then either PUBLISHED to the other participant —
// when it is this browser's own speaker's speech — or SHOWN here, when this
// browser recognised the other person because their device cannot and this
// viewer is the one reading it. Lines per speaker keep their spoken order even
// though translations resolve at different speeds.
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
  // on and they may be captioned — the view explains why.
  uncaptioned: CallRole[];
  // Set when a recogniser here gave up for good (microphone permission, or a
  // language this browser cannot recognise).
  stopped: RecognizerStopReason | null;
};

export type BrowserCaptionsDeps = {
  SpeechRecognition: SpeechRecognitionCtorLike | null;
  Translator: TranslatorApiLike | null;
  fetch: typeof fetch;
  // Send a line to the other participant (its `for`).
  publish: (line: CaptionLine) => Promise<void>;
  // Show a line to this viewer.
  showLocal: (line: CaptionLine) => void;
  onStatus: (status: BrowserCaptionsStatus) => void;
  // The server refused a translation for a reason retrying cannot fix; the
  // hook re-reads the config, which re-runs the assignment.
  onRefused: (reason: TranslationRefusal) => void;
  now?: () => number;
  createRecognizer?: (options: RecognizerOptions) => { start(): void; stop(): void };
};

type Running = {
  key: string;
  recognizer: { start(): void; stop(): void };
  // Serialises this speaker's lines so they are shown in the order spoken.
  chain: Promise<void>;
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

    if (session && input.captionsOn && this.deps.SpeechRecognition) {
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
      });
      uncaptioned = SPEAKERS.filter(
        (s) =>
          assignment[s] === null &&
          room.remote !== null &&
          (s === "teacher" || session.studentConsent),
      );

      for (const speaker of SPEAKERS) {
        if (assignment[speaker] !== me || !room.remote) continue;
        const mine = speaker === me;
        const track = mine ? room.localMicTrack : room.remote.micTrack;
        if (!track || track.readyState === "ended") continue;
        const direction = session.directions[speaker];
        const lang = session.recognitionLocales[speaker];
        const speakerIdentity = mine ? room.localIdentity : room.remote.identity;
        const listenerIdentity = mine ? room.remote.identity : room.localIdentity;
        const key = [
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
    };
    const create = this.deps.createRecognizer ?? ((o: RecognizerOptions) => new TrackRecognizer(o));
    run.recognizer = create({
      Ctor: this.deps.SpeechRecognition as SpeechRecognitionCtorLike,
      track: args.track,
      lang: args.lang,
      onFinal: (text) => {
        run.chain = run.chain.then(() => this.deliver(text, translator, args)).catch(() => {});
      },
      onStopped: (reason) => {
        this.givenUp.add(args.key);
        if (this.running.get(args.speaker) === run) this.running.delete(args.speaker);
        this.stopped = reason;
        this.report({ uncaptioned: [], stopped: reason });
      },
    });
    run.recognizer.start();
    return run;
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
