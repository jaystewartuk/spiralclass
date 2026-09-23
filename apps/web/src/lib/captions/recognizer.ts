import { baseLanguage } from "@spiralclass/shared";
import {
  afterRecognitionEnd,
  isFailure,
  type RecognitionErrorCode,
} from "@/lib/captions/recognition-policy";

// One continuous speech recognition over one audio track, for as long as the
// caller wants it (D-185). The browser's SpeechRecognition ends sessions on
// its own — silence, a network blip, an unstated reason — so this keeps
// starting fresh ones, on the schedule recognition-policy.ts decides, until
// stop() is called or a failure says retrying cannot help.
//
// The track is always passed to start(): the speaker's own LiveKit
// microphone track, or the other participant's remote track when their
// device cannot recognise (caption-recognition.ts). Measured on desktop
// Chrome: recognition then consumes exactly that track — no second capture
// of the microphone, and a muted call mic mutes the captions with it.

// The slice of the Web Speech API this uses. Declared here rather than taken
// from lib.dom so the file compiles the same whichever TypeScript lib version
// is installed, and so a test can hand in a fake.
export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};

export type SpeechResultEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

export type OnDeviceOptions = { langs: string[]; processLocally: true };

export type SpeechRecognitionCtorLike = {
  new (): SpeechRecognitionLike;
  // The on-device API (Chrome). Absent elsewhere.
  available?: (options: OnDeviceOptions) => Promise<string>;
  install?: (options: OnDeviceOptions) => Promise<boolean>;
};

// Chrome's on-device Translator, the slice captions use.
export type TranslatorLike = { translate(text: string): Promise<string> };
export type TranslatorApiLike = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorLike>;
};

// Start downloading this browser's on-device models for a class — the
// translator for each language pair, then the speech model for each
// recognition language — from inside a user gesture. Chrome refuses both
// downloads without one ("Requires a user gesture when availability is
// downloadable", measured), and measured again: the speech install consumes
// the gesture, so a translator created after it in the same click is refused
// while one created first is not. Hence the order, and hence this runs
// synchronously in the teacher's toggle handler, before any await.
//
// Returns without waiting: the downloads finish in the background, and each
// recogniser/translator picks its model up when it next checks. Every
// failure is swallowed — the browser's service and the server route are the
// fallbacks.
export function installOnDeviceModels(args: {
  SpeechRecognition: SpeechRecognitionCtorLike | null;
  Translator: TranslatorApiLike | null;
  recognitionLangs: string[];
  translatorPairs: { sourceLanguage: string; targetLanguage: string }[];
  onTranslatorProgress?: (loaded: number) => void;
}): void {
  const { SpeechRecognition, Translator } = args;
  if (Translator) {
    for (const pair of args.translatorPairs) {
      if (pair.sourceLanguage === pair.targetLanguage) continue;
      Translator.create({
        ...pair,
        monitor: (m) =>
          m.addEventListener("downloadprogress", (e) =>
            args.onTranslatorProgress?.((e as ProgressEvent).loaded),
          ),
      }).catch(() => undefined);
    }
  }
  if (SpeechRecognition && typeof SpeechRecognition.install === "function") {
    for (const lang of args.recognitionLangs) {
      SpeechRecognition.install({ langs: [lang], processLocally: true }).catch(() => false);
    }
  }
}

export type RecognizerStopReason = "permission" | "unsupported";

export type RecognizerOptions = {
  Ctor: SpeechRecognitionCtorLike;
  track: MediaStreamTrack;
  // SpeechRecognition.lang: regional when that is meaningful (recognitionLocale).
  lang: string;
  onFinal: (text: string) => void;
  // Called once, when the recogniser gives up for good.
  onStopped: (reason: RecognizerStopReason) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export class TrackRecognizer {
  private readonly opts: Required<RecognizerOptions>;
  private current: SpeechRecognitionLike | null = null;
  private timer: unknown = null;
  private running = false;
  private failures = 0;
  private lastError: RecognitionErrorCode | null = null;
  private lang: string;
  // Whether to ask for on-device recognition: true once the browser reports
  // the model for this language is installed, false after the local model
  // has refused this language once.
  private local = false;
  private localRefused = false;

  constructor(options: RecognizerOptions) {
    this.opts = {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
    this.lang = options.lang;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.prepareOnDevice();
    this.startSession();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.opts.clearTimeout(this.timer);
    this.timer = null;
    const current = this.current;
    this.current = null;
    if (current) {
      current.onend = null;
      current.onresult = null;
      current.onerror = null;
      try {
        current.abort();
      } catch {
        // Already ended; nothing to abort.
      }
    }
  }

  // On-device recognition keeps the speech on this computer, so it is used
  // whenever the browser already has the model for this language. Getting
  // the model is not this class's job: Chrome refuses install() without a
  // user gesture (measured), so the download is started from the teacher's
  // toggle click by installOnDeviceModels(). Best-effort — any failure here
  // just means the browser's service does the work.
  private async prepareOnDevice(): Promise<void> {
    const { Ctor } = this.opts;
    if (typeof Ctor.available !== "function") return;
    try {
      const availability = await Ctor.available({ langs: [this.lang], processLocally: true });
      if (availability === "available") this.local = !this.localRefused;
    } catch {
      // The browser declined to say; stay on its service.
    }
  }

  private startSession(): void {
    if (!this.running) return;
    const recognition = new this.opts.Ctor();
    recognition.lang = this.lang;
    recognition.continuous = true;
    // Only finished utterances are ever translated and shown; partials would
    // be work thrown away.
    recognition.interimResults = false;
    const local = this.local;
    if (local) recognition.processLocally = true;
    this.lastError = null;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        this.failures = 0;
        this.opts.onFinal(text);
      }
    };
    recognition.onerror = (event) => {
      this.lastError = event.error;
    };
    recognition.onend = () => {
      if (this.current !== recognition) return;
      this.current = null;
      this.afterEnd(this.lastError, local);
    };

    this.current = recognition;
    try {
      recognition.start(this.opts.track);
    } catch {
      // Chrome throws InvalidStateError when asked to start too soon after
      // the previous session, and throws for an ended track. Either way this
      // session never began, so treat it as one that failed.
      this.current = null;
      this.afterEnd("network", local);
    }
  }

  private afterEnd(error: RecognitionErrorCode | null, local: boolean): void {
    if (!this.running) return;
    if (isFailure(error)) this.failures += 1;
    const action = afterRecognitionEnd({
      error,
      consecutiveFailures: this.failures,
      local,
      canFallBackToBareLanguage: this.lang.includes("-"),
    });
    switch (action.kind) {
      case "stop":
        this.stop();
        this.opts.onStopped(action.reason);
        return;
      case "restart-remote":
        this.localRefused = true;
        this.local = false;
        break;
      case "restart-bare-language":
        this.lang = baseLanguage(this.lang);
        break;
      case "restart":
        break;
    }
    // A model the teacher's toggle click started downloading may have landed
    // since this session began; look again before the next one.
    if (!this.localRefused && !this.local) void this.prepareOnDevice();
    this.timer = this.opts.setTimeout(() => {
      this.timer = null;
      this.startSession();
    }, action.delayMs);
  }
}
