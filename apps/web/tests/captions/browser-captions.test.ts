import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionLine, CaptionSession } from "@spiralclass/shared";
import {
  BrowserCaptions,
  type BrowserCaptionsDeps,
  type BrowserCaptionsInput,
} from "@/lib/captions/browser-captions";
import type { RecognizerOptions, SpeechRecognitionCtorLike } from "@/lib/captions/recognizer";

// The controller that decides which speakers THIS browser recognises and
// where each finished line goes. Recognisers are faked (their own loop is
// tested in recognizer.test.ts); the translator is real, talking to a fake
// server, so a line's whole path — recognise, split, translate, build,
// publish-or-show — is asserted.

type FakeRecognizer = RecognizerOptions & { started: boolean; stopped: boolean };
let recognizers: FakeRecognizer[];

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
  const statuses: unknown[] = [];
  const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    return new Response(JSON.stringify({ ok: true, text: `EN(${text})` }), { status: 200 });
  });
  const deps: BrowserCaptionsDeps = {
    SpeechRecognition: function Fake() {} as unknown as SpeechRecognitionCtorLike,
    Translator: null,
    fetch,
    publish: async (line) => {
      published.push(line);
    },
    showLocal: (line) => shown.push(line),
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
    ...over,
  };
  return { c: new BrowserCaptions(deps), published, shown, statuses, fetch, deps };
}

const live = () => recognizers.filter((r) => r.started && !r.stopped);
// Real ticks, not microtasks: Response.json() in Node crosses a macrotask.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  recognizers = [];
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
