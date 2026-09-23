import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TrackRecognizer,
  installOnDeviceModels,
  type SpeechRecognitionCtorLike,
  type SpeechRecognitionLike,
} from "@/lib/captions/recognizer";

// TrackRecognizer against a fake SpeechRecognition. The loop it keeps alive is
// the part that fails silently in a real class — a restart that throws, a
// session that ends and is never replaced — so every way a session ends is
// driven here by hand, with timers stepped explicitly.

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;
  lang = "";
  continuous = false;
  interimResults = true;
  processLocally?: boolean;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  startedWith: MediaStreamTrack | undefined;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(track?: MediaStreamTrack) {
    if (FakeRecognition.throwOnStart) throw new Error("InvalidStateError");
    this.startedWith = track;
  }
  stop() {}
  abort() {
    this.aborted = true;
  }
  final(text: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
  }
  end(error?: string) {
    if (error) this.onerror?.({ error });
    this.onend?.();
  }
}

const track = { id: "mic-1" } as MediaStreamTrack;
let timers: { fn: () => void; ms: number }[];

function make(opts: { Ctor?: SpeechRecognitionCtorLike; lang?: string } = {}) {
  const onFinal = vi.fn();
  const onStopped = vi.fn();
  const r = new TrackRecognizer({
    Ctor: opts.Ctor ?? (FakeRecognition as unknown as SpeechRecognitionCtorLike),
    track,
    lang: opts.lang ?? "es-MX",
    onFinal,
    onStopped,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {
      timers = [];
    },
  });
  return { r, onFinal, onStopped };
}

const latest = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];
const runTimers = () => {
  const due = timers;
  timers = [];
  for (const t of due) t.fn();
};

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
  timers = [];
});

describe("TrackRecognizer", () => {
  it("recognises the given track, continuously, finals only, in the given language", () => {
    const { r } = make();
    r.start();
    expect(latest()).toMatchObject({ lang: "es-MX", continuous: true, interimResults: false });
    expect(latest().startedWith).toBe(track);
  });

  it("hands each non-empty final to the caller, trimmed", () => {
    const { r, onFinal } = make();
    r.start();
    latest().final("  hola  ");
    latest().final("   ");
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("hola");
  });

  it("ignores interim results", () => {
    const { r, onFinal } = make();
    r.start();
    latest().onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "ho" } }] });
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("starts a FRESH instance when a session ends on its own", () => {
    const { r } = make();
    r.start();
    const first = latest();
    first.end("no-speech");
    expect(timers).toHaveLength(1);
    runTimers();
    expect(latest()).not.toBe(first);
    expect(latest().startedWith).toBe(track);
  });

  // The measured failure: a restart that throws, uncaught, ends captions for
  // the rest of the class with no error anywhere.
  it("keeps trying when start() throws, with backoff", () => {
    const { r } = make();
    FakeRecognition.throwOnStart = true;
    r.start();
    expect(timers[0].ms).toBe(1_000);
    runTimers();
    expect(timers[0].ms).toBe(2_000);
    FakeRecognition.throwOnStart = false;
    runTimers();
    expect(latest().startedWith).toBe(track);
  });

  it("resets the backoff once a result arrives", () => {
    const { r } = make();
    r.start();
    latest().end("network");
    runTimers();
    latest().end("network");
    expect(timers[0].ms).toBe(2_000);
    runTimers();
    latest().final("hola");
    latest().end("network");
    expect(timers[0].ms).toBe(1_000);
  });

  it("gives up and says so when the microphone is refused", () => {
    const { r, onStopped } = make();
    r.start();
    latest().end("not-allowed");
    expect(onStopped).toHaveBeenCalledWith("permission");
    expect(timers).toHaveLength(0);
  });

  it("retries a regional language as the bare language", () => {
    const { r } = make({ lang: "es-MX" });
    r.start();
    latest().end("language-not-supported");
    runTimers();
    expect(latest().lang).toBe("es");
  });

  it("stops cleanly: aborts the session and never restarts", () => {
    const { r } = make();
    r.start();
    const session = latest();
    r.stop();
    expect(session.aborted).toBe(true);
    session.onend?.();
    expect(timers).toHaveLength(0);
  });

  it("ignores a second start()", () => {
    const { r } = make();
    r.start();
    r.start();
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  describe("on-device recognition", () => {
    function ctorWith(available: () => Promise<string>) {
      class Local extends FakeRecognition {}
      const Ctor = Local as unknown as SpeechRecognitionCtorLike;
      Ctor.available = vi.fn(available);
      return Ctor;
    }

    it("uses the local model once the browser reports it installed", async () => {
      const Ctor = ctorWith(async () => "available");
      const { r } = make({ Ctor });
      r.start();
      // The first session starts before the answer arrives…
      expect(latest().processLocally).toBeUndefined();
      await Promise.resolve();
      await Promise.resolve();
      latest().end();
      runTimers();
      // …and the next one runs on the device.
      expect(latest().processLocally).toBe(true);
    });

    it("stays on the browser's service while the model is only downloadable", async () => {
      const Ctor = ctorWith(async () => "downloadable");
      const { r } = make({ Ctor });
      r.start();
      await Promise.resolve();
      latest().end();
      runTimers();
      expect(latest().processLocally).toBeUndefined();
    });

    it("falls back to the service when the local model refuses the language", async () => {
      const Ctor = ctorWith(async () => "available");
      const { r } = make({ Ctor });
      r.start();
      await Promise.resolve();
      await Promise.resolve();
      latest().end();
      runTimers();
      expect(latest().processLocally).toBe(true);
      latest().end("language-not-supported");
      runTimers();
      expect(latest().processLocally).toBeUndefined();
    });

    it("stays on the service when the browser will not say", async () => {
      const Ctor = ctorWith(async () => {
        throw new Error("nope");
      });
      const { r } = make({ Ctor });
      r.start();
      await Promise.resolve();
      latest().end();
      runTimers();
      expect(latest().processLocally).toBeUndefined();
    });
  });
});

describe("installOnDeviceModels", () => {
  // Measured in Chrome: the speech install consumes the click's user gesture,
  // so a translator created after it is refused. The order is the fix.
  it("creates translators BEFORE installing speech models, synchronously", () => {
    const order: string[] = [];
    const Translator = {
      availability: vi.fn(),
      create: vi.fn((o: { sourceLanguage: string; targetLanguage: string }) => {
        order.push(`translator:${o.sourceLanguage}-${o.targetLanguage}`);
        return Promise.resolve({ translate: async (t: string) => t });
      }),
    };
    const SpeechRecognition = FakeRecognition as unknown as SpeechRecognitionCtorLike;
    SpeechRecognition.install = vi.fn((o: { langs: string[] }) => {
      order.push(`speech:${o.langs[0]}`);
      return Promise.resolve(true);
    });

    installOnDeviceModels({
      SpeechRecognition,
      Translator,
      recognitionLangs: ["es-MX", "en"],
      translatorPairs: [
        { sourceLanguage: "es", targetLanguage: "en" },
        { sourceLanguage: "en", targetLanguage: "es" },
        { sourceLanguage: "es", targetLanguage: "es" },
      ],
    });

    // Recorded before any await: all of it ran inside the gesture.
    expect(order).toEqual(["translator:es-en", "translator:en-es", "speech:es-MX", "speech:en"]);
  });

  it("reports translator download progress and swallows failures", async () => {
    const progress = vi.fn();
    const Translator = {
      availability: vi.fn(),
      create: vi.fn((o: { monitor?: (m: EventTarget) => void }) => {
        const target = new EventTarget();
        o.monitor?.(target);
        const e = new Event("downloadprogress") as Event & { loaded: number };
        e.loaded = 0.5;
        target.dispatchEvent(e);
        return Promise.reject(new Error("NotAllowedError"));
      }),
    };
    expect(() =>
      installOnDeviceModels({
        SpeechRecognition: null,
        Translator,
        recognitionLangs: [],
        translatorPairs: [{ sourceLanguage: "es", targetLanguage: "en" }],
        onTranslatorProgress: progress,
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it("does nothing in a browser with neither API", () => {
    expect(() =>
      installOnDeviceModels({
        SpeechRecognition: null,
        Translator: null,
        recognitionLangs: ["es"],
        translatorPairs: [{ sourceLanguage: "es", targetLanguage: "en" }],
      }),
    ).not.toThrow();
  });
});
