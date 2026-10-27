import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionLine, CaptionSession } from "@spiralclass/shared";
import {
  BrowserCaptions,
  MAX_KEPT_LINE_MS,
  type BrowserCaptionsDeps,
  type BrowserCaptionsInput,
  type KeptLine,
} from "@/lib/captions/browser-captions";
import type { CloudRecognizerOptions } from "@/lib/captions/cloud-recognizer";
import type { RecognizerOptions, SpeechRecognitionCtorLike } from "@/lib/captions/recognizer";

// The controller that decides which speakers THIS browser recognises and
// where each finished line goes. Recognisers are faked (their own loop is
// tested in recognizer.test.ts); the translator is real, talking to a fake
// server, so a line's whole path — recognise, split, translate, build,
// publish-or-show — is asserted.

type FakeRecognizer = RecognizerOptions & { started: boolean; stopped: boolean };
let recognizers: FakeRecognizer[];
type FakeCloud = CloudRecognizerOptions & { started: boolean; stopped: boolean };
let clouds: FakeCloud[];

const SESSION = (over: Partial<CaptionSession> = {}): CaptionSession => ({
  bookingId: "b1",
  role: "teacher",
  teacherIdentity: "t1",
  directions: {
    teacher: { source: "es", target: "en" },
    student: { source: "en", target: "es" },
  },
  recognitionLocales: { teacher: "es-MX", student: "en" },
  studentConsent: true,
  studentConsentGiver: "student",
  cloudRecognition: false,
  transcriptCapture: false,
  timing: { pauseMs: 0, maxChars: 0 },
  ...over,
});

const localMic = { id: "local-mic", readyState: "live" } as MediaStreamTrack;
const remoteMic = { id: "remote-mic", readyState: "live" } as MediaStreamTrack;

function input(over: Partial<BrowserCaptionsInput> = {}): BrowserCaptionsInput {
  return {
    session: SESSION(),
    captionsOn: true,
    selfCapable: true,
    room: {
      localIdentity: "t1",
      localMicTrack: localMic,
      remote: { identity: "s1", micTrack: remoteMic, capable: true },
    },
    ...over,
  };
}

function setup(over: Partial<BrowserCaptionsDeps> = {}) {
  const published: CaptionLine[] = [];
  const shown: CaptionLine[] = [];
  const kept: KeptLine[] = [];
  const statuses: unknown[] = [];
  const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    return new Response(JSON.stringify({ ok: true, text: `EN(${text})` }), { status: 200 });
  });
  const deps: BrowserCaptionsDeps = {
    SpeechRecognition: function Fake() {} as unknown as SpeechRecognitionCtorLike,
    Translator: null,
    WebSocket: null,
    MediaRecorder: null,
    fetch,
    publish: async (line) => {
      published.push(line);
    },
    showLocal: (line) => shown.push(line),
    keep: (line) => kept.push(line),
    onStatus: (s) => statuses.push(s),
    onRefused: vi.fn(),
    now: () => 1_000,
    createRecognizer: (o) => {
      const r: FakeRecognizer = { ...o, started: false, stopped: false };
      recognizers.push(r);
      return {
        start: () => {
          r.started = true;
        },
        stop: () => {
          r.stopped = true;
        },
      };
    },
    createCloudRecognizer: (o) => {
      const r: FakeCloud = { ...o, started: false, stopped: false };
      clouds.push(r);
      return {
        start: () => {
          r.started = true;
        },
        stop: () => {
          r.stopped = true;
        },
      };
    },
    ...over,
  };
  return { c: new BrowserCaptions(deps), published, shown, kept, statuses, fetch, deps };
}

const live = () => recognizers.filter((r) => r.started && !r.stopped);
// Real ticks, not microtasks: Response.json() in Node crosses a macrotask.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  recognizers = [];
  clouds = [];
});

describe("BrowserCaptions — who recognises whom", () => {
  it("recognises only its own speaker's mic when both browsers can", () => {
    const { c } = setup();
    c.sync(input());
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ track: localMic, lang: "es-MX" });
  });

  it("also recognises the student's remote track when her phone cannot", () => {
    const { c } = setup();
    c.sync(
      input({
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    expect(live().map((r) => r.track)).toEqual([localMic, remoteMic]);
    expect(live()[1].lang).toBe("en");
  });

  it("recognises nothing on a phone whose other side can", () => {
    const { c } = setup();
    c.sync(input({ selfCapable: false }));
    expect(live()).toHaveLength(0);
  });

  it("never recognises the student without consent, and does not call that uncaptioned", () => {
    const { c, statuses } = setup();
    c.sync(
      input({
        session: SESSION({ studentConsent: false }),
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    expect(live().map((r) => r.track)).toEqual([localMic]);
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: null });
  });

  it("reports both speakers uncaptioned when neither browser can recognise", () => {
    const { c, statuses } = setup();
    c.sync(
      input({
        selfCapable: false,
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    expect(live()).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ uncaptioned: ["teacher", "student"], stopped: null });
  });

  it("runs nothing while captions are off, without a session, or alone in the room", () => {
    const { c } = setup();
    c.sync(input({ captionsOn: false }));
    c.sync(input({ session: null }));
    c.sync(input({ room: { ...input().room, remote: null } }));
    expect(recognizers).toHaveLength(0);
  });

  it("runs nothing in a browser without SpeechRecognition", () => {
    const { c } = setup({ SpeechRecognition: null });
    c.sync(input());
    expect(recognizers).toHaveLength(0);
  });

  it("waits for a track rather than starting on a missing or ended one", () => {
    const { c } = setup();
    c.sync(input({ room: { ...input().room, localMicTrack: null } }));
    c.sync(
      input({
        room: {
          ...input().room,
          localMicTrack: { id: "x", readyState: "ended" } as MediaStreamTrack,
        },
      }),
    );
    expect(recognizers).toHaveLength(0);
  });
});

describe("BrowserCaptions — the cloud fallback (two phones)", () => {
  const phones = (over: Partial<BrowserCaptionsInput> = {}) =>
    input({
      selfCapable: false,
      session: SESSION({ cloudRecognition: true }),
      room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      ...over,
    });
  const liveClouds = () => clouds.filter((r) => r.started && !r.stopped);

  it("streams its own speaker's mic, and nobody else's, when neither browser can recognise", () => {
    const { c, statuses } = setup();
    c.sync(phones());
    expect(liveClouds()).toHaveLength(1);
    expect(liveClouds()[0]).toMatchObject({ track: localMic, bookingId: "b1" });
    expect(recognizers).toHaveLength(0);
    // Nobody is left uncaptioned, so the "needs a computer" notice goes.
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: null });
  });

  it("streams even in a browser without the Web Speech API", () => {
    const { c } = setup({ SpeechRecognition: null });
    c.sync(phones());
    expect(liveClouds()).toHaveLength(1);
  });

  it("never streams when either browser in the room can recognise", () => {
    const { c } = setup();
    c.sync(phones({ selfCapable: true }));
    c.sync(
      phones({
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: true } },
      }),
    );
    expect(clouds).toHaveLength(0);
  });

  it("stops streaming the moment a computer that can recognise joins the other side", () => {
    const { c } = setup();
    c.sync(phones());
    c.sync(
      phones({
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: true } },
      }),
    );
    expect(liveClouds()).toHaveLength(0);
  });

  it("never streams the student's speech without her consent", () => {
    const { c, statuses } = setup();
    c.sync(
      phones({
        session: SESSION({ role: "student", cloudRecognition: true, studentConsent: false }),
        room: {
          localIdentity: "s1",
          localMicTrack: localMic,
          remote: { identity: "t1", micTrack: remoteMic, capable: false },
        },
      }),
    );
    expect(clouds).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: null });
  });

  it("still reports both uncaptioned when the fallback is not configured", () => {
    const { c, statuses } = setup();
    c.sync(phones({ session: SESSION({ cloudRecognition: false }) }));
    expect(clouds).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ uncaptioned: ["teacher", "student"], stopped: null });
  });

  it("publishes a cloud final to the other participant like any line of its own", async () => {
    const { c, published } = setup();
    c.sync(phones());
    liveClouds()[0].onFinal("Hola");
    await flush();
    expect(published).toEqual([
      expect.objectContaining({ for: "s1", from: "t1", text: "EN(Hola)", src: "Hola" }),
    ]);
  });

  it("reports a fallback that gave up, and does not restart it for the same track", () => {
    const { c, statuses } = setup();
    c.sync(phones());
    liveClouds()[0].onStopped("unavailable");
    c.sync(phones());
    expect(clouds).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: "unavailable" });
  });

  it("passes a server refusal up so the hook re-reads the config", () => {
    const { c, deps } = setup();
    c.sync(phones());
    liveClouds()[0].onRefused("no-consent");
    expect(deps.onRefused).toHaveBeenCalledWith("no-consent");
  });

  it("stops the stream on dispose", () => {
    const { c } = setup();
    c.sync(phones());
    c.dispose();
    expect(liveClouds()).toHaveLength(0);
  });
});

describe("BrowserCaptions — keeping the transcript (D-189)", () => {
  const keptSession = () => SESSION({ transcriptCapture: true });

  it("keeps nothing while the session does not say the transcript is kept", async () => {
    const { c, kept, published } = setup();
    c.sync(input());
    live()[0].onFinal("Hola");
    await flush();
    expect(published).toHaveLength(1);
    expect(kept).toEqual([]);
  });

  it("keeps each recognised line, source text and speaker, before translating it", () => {
    const { c, kept, fetch } = setup();
    c.sync(input({ session: keptSession() }));
    live()[0].onFinal("Buenos días");
    // Synchronously, ahead of the translation round-trip.
    expect(kept).toEqual([
      { bookingId: "b1", speaker: "teacher", text: "Buenos días", durationMs: 0 },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the other person's line too when this browser recognised her", () => {
    const { c, kept } = setup();
    c.sync(
      input({
        session: keptSession(),
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    live()[1].onFinal("how are you");
    expect(kept).toEqual([expect.objectContaining({ speaker: "student", text: "how are you" })]);
  });

  it("estimates a line's duration as the gap since the speaker's previous line, capped", () => {
    let t = 1_000;
    const { c, kept } = setup({ now: () => t });
    c.sync(input({ session: keptSession() }));
    t = 3_500;
    live()[0].onFinal("uno");
    t = 5_000;
    live()[0].onFinal("dos");
    t = 5_000 + MAX_KEPT_LINE_MS + 99_999;
    live()[0].onFinal("tres");
    expect(kept.map((k) => k.durationMs)).toEqual([2_500, 1_500, MAX_KEPT_LINE_MS]);
  });

  it("splits a long utterance the way the route requires and shares the duration by length", () => {
    let t = 1_000;
    const { c, kept } = setup({ now: () => t });
    c.sync(input({ session: keptSession() }));
    t = 11_000;
    const sentence = "palabra ".repeat(80).trim(); // ~640 chars, over MAX_CAPTION_CHARS
    live()[0].onFinal(sentence);
    expect(kept.length).toBeGreaterThan(1);
    for (const k of kept) expect(k.text.length).toBeLessThanOrEqual(500);
    expect(kept.reduce((n, k) => n + k.durationMs, 0)).toBeGreaterThanOrEqual(9_990);
    expect(kept.reduce((n, k) => n + k.durationMs, 0)).toBeLessThanOrEqual(10_010);
  });

  it("keeps a cloud-recognised line the same way", () => {
    const { c, kept } = setup();
    c.sync(
      input({
        selfCapable: false,
        session: SESSION({ cloudRecognition: true, transcriptCapture: true }),
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    clouds[0].onFinal("Hola");
    expect(kept).toEqual([expect.objectContaining({ speaker: "teacher", text: "Hola" })]);
  });
});

describe("BrowserCaptions — reconciling", () => {
  it("keeps a running recogniser across syncs that change nothing", () => {
    const { c } = setup();
    c.sync(input());
    c.sync(input());
    expect(recognizers).toHaveLength(1);
  });

  it("stops everything when the switch goes off", () => {
    const { c } = setup();
    c.sync(input());
    c.sync(input({ captionsOn: false }));
    expect(live()).toHaveLength(0);
  });

  it("restarts on a new mic track (the call republished it)", () => {
    const { c } = setup();
    c.sync(input());
    const replaced = { id: "local-mic-2", readyState: "live" } as MediaStreamTrack;
    c.sync(input({ room: { ...input().room, localMicTrack: replaced } }));
    expect(recognizers[0].stopped).toBe(true);
    expect(live()[0].track).toBe(replaced);
  });

  it("restarts when a mid-class language override arrives with the next config", () => {
    const { c } = setup();
    c.sync(input());
    c.sync(input({ session: SESSION({ recognitionLocales: { teacher: "fr", student: "en" } }) }));
    expect(live()[0].lang).toBe("fr");
  });

  it("hands the student back to her own browser when it can recognise after all", () => {
    const { c } = setup();
    const phone = input({
      room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
    });
    c.sync(phone);
    expect(live()).toHaveLength(2);
    c.sync(input());
    expect(live().map((r) => r.track)).toEqual([localMic]);
  });

  it("does not restart a recogniser that gave up, and reports why", () => {
    const { c, statuses } = setup();
    c.sync(input());
    recognizers[0].onStopped("permission");
    c.sync(input());
    expect(recognizers).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: "permission" });
  });

  it("stops everything on dispose, and ignores later syncs", () => {
    const { c } = setup();
    c.sync(input());
    c.dispose();
    c.sync(input());
    expect(live()).toHaveLength(0);
    expect(recognizers).toHaveLength(1);
  });

  it("reports status only when it changes", () => {
    const { c, statuses } = setup();
    c.sync(input());
    c.sync(input());
    expect(statuses).toHaveLength(1);
  });
});

describe("BrowserCaptions — where lines go", () => {
  it("publishes its own speaker's translated line to the other participant", async () => {
    const { c, published, shown } = setup();
    c.sync(input());
    recognizers[0].onFinal("¿Cómo estás?");
    await flush();
    expect(shown).toHaveLength(0);
    expect(published).toEqual([
      {
        t: "line",
        for: "s1",
        id: "t1:1000-0",
        text: "EN(¿Cómo estás?)",
        src: "¿Cómo estás?",
        from: "t1",
        lang: "en",
        srcLang: "es",
      },
    ]);
  });

  it("shows, never publishes, a line it recognised from the other participant", async () => {
    const { c, published, shown, fetch } = setup();
    c.sync(
      input({
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    recognizers[1].onFinal("How are you?");
    await flush();
    expect(published).toHaveLength(0);
    expect(shown[0]).toMatchObject({ for: "t1", from: "s1", lang: "es", srcLang: "en" });
    // Translated as the STUDENT's speech, which is what the route checks
    // consent against.
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ speaker: "student" });
  });

  it("splits a long utterance to the route's size and keeps the pieces in order", async () => {
    const { c, published } = setup();
    c.sync(input());
    const long = `${"a".repeat(300)}. ${"b".repeat(300)}.`;
    recognizers[0].onFinal(long);
    await flush();
    expect(published).toHaveLength(2);
    expect(published[0].src?.startsWith("aaa")).toBe(true);
    expect(published[1].src?.startsWith("bbb")).toBe(true);
  });

  it("keeps lines in spoken order when an earlier translation is slower", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      if (text === "primero") await slow;
      return new Response(JSON.stringify({ ok: true, text }), { status: 200 });
    });
    const { c, published } = setup({ fetch });
    c.sync(input());
    recognizers[0].onFinal("primero");
    recognizers[0].onFinal("segundo");
    await flush();
    expect(published).toHaveLength(0);
    release();
    await flush();
    expect(published.map((l) => l.text)).toEqual(["primero", "segundo"]);
  });

  it("drops a line the translation fails on and carries on with the next", async () => {
    let n = 0;
    const fetch = vi.fn(async () =>
      ++n === 1
        ? new Response(JSON.stringify({ reason: "translate-failed" }), { status: 502 })
        : new Response(JSON.stringify({ ok: true, text: "ok" }), { status: 200 }),
    );
    const { c, published } = setup({ fetch });
    c.sync(input());
    recognizers[0].onFinal("uno");
    recognizers[0].onFinal("dos");
    await flush();
    expect(published.map((l) => l.text)).toEqual(["ok"]);
  });

  it("passes a server refusal up so the hook re-reads the config", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ reason: "captions-off" }), { status: 403 }),
    );
    const { c, deps } = setup({ fetch });
    c.sync(input());
    recognizers[0].onFinal("hola");
    await flush();
    expect(deps.onRefused).toHaveBeenCalledWith("captions-off");
  });

  it("never publishes a translation that lands after dispose", async () => {
    const { c, published } = setup();
    c.sync(input());
    recognizers[0].onFinal("hola");
    c.dispose();
    await flush();
    expect(published).toHaveLength(0);
  });
});

// D-198. Measured 2026-10-12: a teacher's phrases ran to ~500 characters, and
// a listener reading the translation saw nothing until each one ended and
// its translation came back. The words now go out as they are heard.
// D-206: a reader of a TRANSLATION is told only that the speaker is talking —
// the words themselves would be a second language on her screen.
describe("BrowserCaptions — words as they are spoken (D-198, D-206)", () => {
  // A student who reads the teacher's own language: nothing to translate, so
  // the words go out as they are heard.
  const sameLanguage = () =>
    input({
      session: SESSION({
        directions: {
          teacher: { source: "es", target: "es" },
          student: { source: "es", target: "es" },
        },
      }),
    });

  it("publishes a wordless partial under one id that the translated line then takes", async () => {
    const { c, published, fetch } = setup();
    c.sync(input());
    recognizers[0].onPartial?.("¿Cómo");
    recognizers[0].onPartial?.("¿Cómo estás");
    expect(fetch).not.toHaveBeenCalled();
    const speaking = {
      t: "line",
      for: "s1",
      id: "t1:1000-0",
      text: "",
      from: "t1",
      lang: "en",
      partial: true,
    };
    expect(published).toEqual([speaking, speaking]);
    recognizers[0].onFinal("¿Cómo estás?");
    await flush();
    expect(published[2]).toEqual({
      t: "line",
      for: "s1",
      id: "t1:1000-0",
      text: "EN(¿Cómo estás?)",
      src: "¿Cómo estás?",
      from: "t1",
      lang: "en",
      srcLang: "es",
    });
  });

  it("publishes the words so far to a reader of the speaker's own language", () => {
    const { c, published } = setup();
    c.sync(sameLanguage());
    recognizers[0].onPartial?.("¿Cómo estás");
    expect(published).toEqual([
      expect.objectContaining({ text: "¿Cómo estás", lang: "es", partial: true }),
    ]);
  });

  it("never puts an untranslated word on the wire for a reader of a translation", () => {
    const { c, published } = setup();
    c.sync(input());
    recognizers[0].onPartial?.("¿Cómo");
    recognizers[0].onPartial?.("¿Cómo estás hoy");
    expect(published.every((l) => l.text === "")).toBe(true);
  });

  it("starts a new id for the next utterance", async () => {
    const { c, published } = setup();
    c.sync(input());
    recognizers[0].onPartial?.("uno");
    recognizers[0].onFinal("uno");
    recognizers[0].onPartial?.("dos");
    await flush();
    const ids = published.map((l) => `${l.partial ? "p" : "f"}:${l.id}`);
    expect(ids).toEqual(["p:t1:1000-0", "p:t1:1000-1", "f:t1:1000-0"]);
  });

  it("shows the next utterance is being spoken while the previous one is still being translated", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      await slow;
      return new Response(JSON.stringify({ ok: true, text: `EN(${text})` }), { status: 200 });
    });
    const { c, published } = setup({ fetch });
    c.sync(input());
    recognizers[0].onFinal("una frase larga");
    recognizers[0].onPartial?.("y la siguiente");
    await flush();
    expect(published).toEqual([expect.objectContaining({ text: "", partial: true })]);
    release();
    await flush();
    expect(published[1]).toMatchObject({ text: "EN(una frase larga)" });
  });

  it("shows, never publishes, the partial of the other participant it is recognising", () => {
    const { c, published, shown } = setup();
    c.sync(
      input({
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    recognizers[1].onPartial?.("How are");
    expect(published).toHaveLength(0);
    expect(shown).toEqual([
      expect.objectContaining({
        for: "t1",
        from: "s1",
        lang: "es",
        text: "",
        partial: true,
      }),
    ]);
  });

  it("never keeps a partial in the transcript", () => {
    const { c, kept } = setup();
    c.sync(input({ session: SESSION({ transcriptCapture: true }) }));
    recognizers[0].onPartial?.("hola");
    expect(kept).toHaveLength(0);
  });

  it("carries only the tail of a long run of speech, cut at a word", () => {
    const { c, published } = setup();
    c.sync(sameLanguage());
    recognizers[0].onPartial?.(`${"palabra ".repeat(40)}final`);
    const text = published[0].text;
    expect(text.startsWith("…palabra")).toBe(true);
    expect(text.endsWith("final")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(141);
  });

  it("gives a long utterance's first piece the partial's id and the rest new ones", async () => {
    const { c, published } = setup();
    c.sync(input());
    recognizers[0].onPartial?.("aaa");
    recognizers[0].onFinal(`${"a".repeat(300)}. ${"b".repeat(300)}.`);
    await flush();
    const [partial, first, second] = published.map((l) => l.id);
    expect(first).toBe(partial);
    expect(second).not.toBe(partial);
  });

  it("publishes a cloud recogniser's partials the same way", () => {
    const { c, published } = setup({ SpeechRecognition: null });
    c.sync(
      input({
        session: SESSION({ cloudRecognition: true }),
        selfCapable: false,
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    clouds[0].onPartial?.("hola");
    expect(published).toEqual([expect.objectContaining({ text: "", partial: true })]);
  });
});

// The teacher's subtitle timing (caption-timing.ts): cutting an utterance
// short of the browser's own final, without ever repeating or losing a word.
describe("BrowserCaptions — the teacher's subtitle timing", () => {
  // A hand-driven clock so a pause is a number, not a wait.
  function clock() {
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let now = 0;
    return {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (h: unknown) => void timers.delete(h as number),
      advance(ms: number) {
        now += ms;
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
          }
        }
      },
    };
  }
  const timed = (timing: { pauseMs: number; maxChars: number }) =>
    SESSION({ timing, transcriptCapture: true });
  const texts = (lines: CaptionLine[]) => lines.filter((l) => !l.partial).map((l) => l.text);

  it("does nothing the browser would not do with both dials off", async () => {
    const k = clock();
    const { c, published } = setup({ setTimeout: k.setTimeout, clearTimeout: k.clearTimeout });
    c.sync(input());
    recognizers[0].onPartial?.("uno dos tres");
    k.advance(60_000);
    await flush();
    expect(texts(published)).toEqual([]);
    recognizers[0].onFinal("uno dos tres cuatro");
    await flush();
    expect(texts(published)).toEqual(["EN(uno dos tres cuatro)"]);
  });

  it("translates what was heard once nothing new has been heard for the pause", async () => {
    const k = clock();
    const { c, published, kept } = setup({
      setTimeout: k.setTimeout,
      clearTimeout: k.clearTimeout,
    });
    c.sync(input({ session: timed({ pauseMs: 800, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos");
    k.advance(500);
    recognizers[0].onPartial?.("uno dos tres"); // more speech restarts the wait
    k.advance(500);
    await flush();
    expect(texts(published)).toEqual([]);
    k.advance(400);
    await flush();
    expect(texts(published)).toEqual(["EN(uno dos tres)"]);
    expect(kept.map((l) => l.text)).toEqual(["uno dos tres"]);
  });

  it("does not repeat the cut part when the utterance carries on and the browser finishes it", async () => {
    const k = clock();
    const { c, published, kept } = setup({
      setTimeout: k.setTimeout,
      clearTimeout: k.clearTimeout,
    });
    c.sync(input({ session: timed({ pauseMs: 800, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos tres");
    k.advance(800);
    recognizers[0].onPartial?.("uno dos tres cuatro cinco");
    recognizers[0].onFinal("uno dos tres cuatro cinco seis");
    await flush();
    expect(texts(published)).toEqual(["EN(uno dos tres)", "EN(cuatro cinco seis)"]);
    expect(kept.map((l) => l.text)).toEqual(["uno dos tres", "cuatro cinco seis"]);
  });

  it("drops the browser's final when everything in it was already cut", async () => {
    const k = clock();
    const { c, published, kept } = setup({
      setTimeout: k.setTimeout,
      clearTimeout: k.clearTimeout,
    });
    c.sync(input({ session: timed({ pauseMs: 800, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos tres");
    k.advance(800);
    recognizers[0].onFinal("uno dos tres");
    await flush();
    expect(texts(published)).toEqual(["EN(uno dos tres)"]);
    expect(kept).toHaveLength(1);
  });

  it("cuts a run with no pause at the length limit, before the word still being heard", async () => {
    const k = clock();
    const { c, published } = setup({ setTimeout: k.setTimeout, clearTimeout: k.clearTimeout });
    c.sync(input({ session: timed({ pauseMs: 0, maxChars: 40 }) }));
    recognizers[0].onPartial?.("one two three four five six seven eight nine ten");
    await flush();
    expect(texts(published)).toEqual(["EN(one two three four five six seven eight nine)"]);
    // What is left is shown as the next partial, under its own id.
    const partials = published.filter((l) => l.partial);
    const cut = published.find((l) => !l.partial);
    expect(partials.at(-1)?.id).not.toBe(cut?.id);
    recognizers[0].onFinal("one two three four five six seven eight nine ten eleven");
    await flush();
    expect(texts(published).at(-1)).toBe("EN(ten eleven)");
  });

  it("applies a changed setting to an utterance already in flight", async () => {
    const k = clock();
    const { c, published } = setup({ setTimeout: k.setTimeout, clearTimeout: k.clearTimeout });
    c.sync(input({ session: timed({ pauseMs: 0, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos");
    c.sync(input({ session: timed({ pauseMs: 600, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos tres");
    k.advance(600);
    await flush();
    expect(texts(published)).toEqual(["EN(uno dos tres)"]);
  });

  it("cuts nothing after the recogniser is stopped", async () => {
    const k = clock();
    const { c, published } = setup({ setTimeout: k.setTimeout, clearTimeout: k.clearTimeout });
    c.sync(input({ session: timed({ pauseMs: 800, maxChars: 0 }) }));
    recognizers[0].onPartial?.("uno dos");
    c.dispose();
    k.advance(5_000);
    await flush();
    expect(texts(published)).toEqual([]);
  });
});

describe("BrowserCaptions — the transcript without subtitles (D-203)", () => {
  const consenting = () => SESSION({ transcriptCapture: true });
  const hidden = (over: Partial<BrowserCaptionsInput> = {}) =>
    input({ captionsOn: false, session: consenting(), ...over });

  it("recognises and keeps a consenting class's lines with subtitles off", async () => {
    const { c, kept, published, shown, fetch } = setup();
    c.sync(hidden());
    expect(live()).toHaveLength(1);
    live()[0].onFinal("hola");
    await flush();
    expect(kept).toEqual([{ bookingId: "b1", speaker: "teacher", text: "hola", durationMs: 0 }]);
    // Display only: nothing translated, published or shown.
    expect(fetch).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });

  it("shows no partial line while subtitles are off", () => {
    const { c, published, shown } = setup();
    c.sync(hidden());
    live()[0].onPartial?.("ho");
    expect(published).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });

  it("keeps nothing for a class without recorded consent, subtitles off", () => {
    const { c } = setup();
    c.sync(input({ captionsOn: false, session: SESSION({ transcriptCapture: false }) }));
    expect(recognizers).toHaveLength(0);
  });

  it("never recognises the student's speech without her captions consent", () => {
    const { c } = setup();
    c.sync(
      hidden({
        session: SESSION({ transcriptCapture: true, studentConsent: false }),
        room: { ...input().room, remote: { identity: "s1", micTrack: remoteMic, capable: false } },
      }),
    );
    expect(live().map((r) => r.track)).toEqual([localMic]);
  });

  it("keeps recognising across the switch flipping, and starts showing lines", async () => {
    const { c, published } = setup();
    c.sync(hidden());
    const first = live()[0];
    c.sync(input({ session: consenting() }));
    expect(recognizers).toHaveLength(1);
    expect(first.stopped).toBe(false);
    first.onFinal("hola");
    await flush();
    expect(published).toHaveLength(1);
    c.sync(hidden());
    expect(first.stopped).toBe(false);
  });

  it("keeps whole utterances, not the teacher's subtitle timing's cuts, while subtitles are off", async () => {
    let id = 0;
    const timers = new Map<number, () => void>();
    const { c, kept, published } = setup({
      setTimeout: (fn) => {
        timers.set(++id, fn);
        return id;
      },
      clearTimeout: (h) => void timers.delete(h as number),
    });
    c.sync(
      hidden({
        session: SESSION({ transcriptCapture: true, timing: { pauseMs: 800, maxChars: 40 } }),
      }),
    );
    live()[0].onPartial?.("one two three four five six seven eight nine ten");
    for (const fn of [...timers.values()]) fn();
    live()[0].onFinal("one two three four five six seven eight nine ten eleven");
    await flush();
    expect(kept.map((l) => l.text)).toEqual([
      "one two three four five six seven eight nine ten eleven",
    ]);
    expect(published).toHaveLength(0);
  });

  it("does not report speakers as uncaptioned while nothing is meant to be shown", () => {
    const { c, statuses } = setup({ SpeechRecognition: null });
    c.sync(hidden({ selfCapable: false }));
    expect(statuses.at(-1)).toEqual({ uncaptioned: [], stopped: null });
  });
});
