// @vitest-environment jsdom
//
// useBrowserCaptions — the React + LiveKit wiring for browser captions
// (D-185). The decisions it feeds are tested in browser-captions.test.ts;
// this pins the wiring itself against a fake room: the capability attribute
// it publishes, when it asks the server for the class's caption session and
// how often, whose switch it trusts, and that a recognised line leaves through
// the right door (published to the other person, or shown here).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import type { CaptionLine, CaptionSession } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { useBrowserCaptions, CONFIG_POLL_MS } = await import("@/lib/captions/use-browser-captions");

// ---- fakes ---------------------------------------------------------------

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static available = vi.fn(async () => "unavailable");
  static install = vi.fn(async () => true);
  lang = "";
  continuous = false;
  interimResults = true;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  track: unknown = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(track?: unknown) {
    this.track = track;
  }
  stop() {}
  abort() {}
  final(text: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
  }
}

type Attrs = Record<string, string>;
class FakeParticipant {
  attributes: Attrs = {};
  constructor(
    public identity: string,
    public micTrack: { id: string; readyState: string } | null,
  ) {}
  getTrackPublication() {
    return this.micTrack ? { track: { mediaStreamTrack: this.micTrack } } : undefined;
  }
}

class FakeRoom {
  handlers = new Map<string, Set<() => void>>();
  localParticipant: FakeParticipant & {
    setAttributes: ReturnType<typeof vi.fn>;
    publishData: ReturnType<typeof vi.fn>;
  };
  remoteParticipants = new Map<string, FakeParticipant>();
  constructor(localIdentity: string) {
    const p = new FakeParticipant(localIdentity, {
      id: `${localIdentity}-mic`,
      readyState: "live",
    });
    this.localParticipant = Object.assign(p, {
      setAttributes: vi.fn(async (a: Attrs) => {
        Object.assign(p.attributes, a);
      }),
      publishData: vi.fn(async () => {}),
    });
  }
  on(event: string, fn: () => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: () => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string) {
    for (const fn of this.handlers.get(event) ?? []) fn();
  }
  join(p: FakeParticipant) {
    this.remoteParticipants.set(p.identity, p);
    this.emit("participantConnected");
  }
}

const SESSION = (
  role: "teacher" | "student",
  over: Partial<CaptionSession> = {},
): CaptionSession => ({
  bookingId: "b1",
  role,
  teacherIdentity: "t1",
  directions: {
    teacher: { source: "es", target: "en" },
    student: { source: "en", target: "es" },
  },
  recognitionLocales: { teacher: "es-MX", student: "en" },
  studentConsent: true,
  ...over,
});

let configReplies: unknown[];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/captions/config") {
    const next = configReplies.length > 1 ? configReplies.shift() : configReplies[0];
    return new Response(JSON.stringify(next), { status: 200 });
  }
  const { text } = JSON.parse(String(init?.body)) as { text: string };
  return new Response(JSON.stringify({ ok: true, text: `T(${text})` }), { status: 200 });
});

// ---- harness -------------------------------------------------------------

type HookResult = ReturnType<typeof useBrowserCaptions>;
let latest: HookResult;
const shown: CaptionLine[] = [];

function Harness(props: {
  room: FakeRoom | null;
  role: "teacher" | "student";
  teacherCaptionsOn: boolean;
  prefetchSession: boolean;
}) {
  latest = useBrowserCaptions({
    room: props.room as never,
    bookingId: "b1",
    role: props.role,
    teacherCaptionsOn: props.teacherCaptionsOn,
    prefetchSession: props.prefetchSession,
    showLocal: (line) => shown.push(line),
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  });
};
async function render(props: Parameters<typeof Harness>[0]) {
  act(() => root.render(<Harness {...props} />));
  await settle();
}

beforeEach(() => {
  FakeRecognition.instances = [];
  shown.length = 0;
  configReplies = [{ ok: true, enabled: true, session: SESSION("teacher") }];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  Object.defineProperty(navigator, "userAgentData", {
    value: { mobile: false, brands: [{ brand: "Chromium" }] },
    configurable: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (window as unknown as Record<string, unknown>).Translator;
});

const configCalls = () => fetchMock.mock.calls.filter(([u]) => u === "/api/captions/config");

// ---- tests ---------------------------------------------------------------

describe("useBrowserCaptions — what it tells the room", () => {
  it("publishes that this browser can recognise during a call", async () => {
    const room = new FakeRoom("t1");
    await render({ room, role: "teacher", teacherCaptionsOn: false, prefetchSession: false });
    expect(room.localParticipant.setAttributes).toHaveBeenCalledWith({ captionsAsr: "1" });
  });

  it("publishes that a phone cannot", async () => {
    Object.defineProperty(navigator, "userAgentData", {
      value: { mobile: true, brands: [{ brand: "Chromium" }] },
      configurable: true,
    });
    const room = new FakeRoom("s1");
    await render({ room, role: "student", teacherCaptionsOn: false, prefetchSession: false });
    expect(room.localParticipant.setAttributes).toHaveBeenCalledWith({ captionsAsr: "0" });
  });

  it("does nothing without a room", async () => {
    await render({ room: null, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest.captionsOn).toBe(true);
  });
});

describe("useBrowserCaptions — the class's caption session", () => {
  it("fetches it at connect for the teacher, before any toggle, and does not poll while off", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const room = new FakeRoom("t1");
    await render({ room, role: "teacher", teacherCaptionsOn: false, prefetchSession: true });
    expect(configCalls()).toHaveLength(1);
    expect(JSON.parse(String(configCalls()[0][1]?.body))).toEqual({ bookingId: "b1" });
    act(() => vi.advanceTimersByTime(CONFIG_POLL_MS * 2));
    await settle();
    expect(configCalls()).toHaveLength(1);
  });

  it("re-reads it every minute while captions are on", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const room = new FakeRoom("t1");
    room.join(new FakeParticipant("s1", { id: "s1-mic", readyState: "live" }));
    await render({ room, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });
    const before = configCalls().length;
    act(() => vi.advanceTimersByTime(CONFIG_POLL_MS));
    await settle();
    expect(configCalls().length).toBe(before + 1);
  });

  it("does not ask the server at all for a student while the teacher's switch is off", async () => {
    const room = new FakeRoom("s1");
    room.join(new FakeParticipant("t1", { id: "t1-mic", readyState: "live" }));
    await render({ room, role: "student", teacherCaptionsOn: false, prefetchSession: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest.captionsOn).toBe(false);
  });
});

describe("useBrowserCaptions — recognising and delivering", () => {
  it("recognises the teacher's own mic and publishes her line to the student", async () => {
    const room = new FakeRoom("t1");
    room.join(new FakeParticipant("s1", { id: "s1-mic", readyState: "live" }));
    const student = room.remoteParticipants.get("s1")!;
    student.attributes.captionsAsr = "1";
    await render({ room, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });

    expect(FakeRecognition.instances).toHaveLength(1);
    const rec = FakeRecognition.instances[0];
    expect(rec.track).toEqual({ id: "t1-mic", readyState: "live" });
    expect(rec.lang).toBe("es-MX");

    rec.final("hola");
    await settle();
    expect(room.localParticipant.publishData).toHaveBeenCalledTimes(1);
    const [, opts] = room.localParticipant.publishData.mock.calls[0] as [Uint8Array, unknown];
    expect(opts).toEqual({ reliable: true, topic: "captions", destinationIdentities: ["s1"] });
    expect(shown).toHaveLength(0);
  });

  it("recognises a student on a phone from the call audio and shows her line here", async () => {
    const room = new FakeRoom("t1");
    room.join(new FakeParticipant("s1", { id: "s1-mic", readyState: "live" }));
    room.remoteParticipants.get("s1")!.attributes.captionsAsr = "0";
    await render({ room, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });

    const remoteRec = FakeRecognition.instances.find(
      (r) => (r.track as { id: string }).id === "s1-mic",
    )!;
    expect(remoteRec.lang).toBe("en");
    remoteRec.final("how are you");
    await settle();
    expect(shown[0]).toMatchObject({ for: "t1", from: "s1", text: "T(how are you)" });
  });

  it("follows the teacher's attribute on the student's side, and only hers", async () => {
    configReplies = [{ ok: true, enabled: true, session: SESSION("student") }];
    const room = new FakeRoom("s1");
    const teacher = new FakeParticipant("t1", { id: "t1-mic", readyState: "live" });
    teacher.attributes.captionsAsr = "1";
    room.join(teacher);
    await render({ room, role: "student", teacherCaptionsOn: false, prefetchSession: false });
    expect(latest.captionsOn).toBe(false);

    teacher.attributes.captionsOn = "true";
    act(() => room.emit("participantAttributesChanged"));
    await settle();
    expect(latest.captionsOn).toBe(true);
    // Her own speech, on her own capable browser.
    expect(FakeRecognition.instances.map((r) => (r.track as { id: string }).id)).toEqual([
      "s1-mic",
    ]);
  });

  it("stops recognising when the server says captions are off for this class", async () => {
    const room = new FakeRoom("t1");
    room.join(new FakeParticipant("s1", { id: "s1-mic", readyState: "live" }));
    configReplies = [{ ok: true, enabled: false }];
    await render({ room, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("re-reads the session at once after a translation refusal", async () => {
    const room = new FakeRoom("t1");
    room.join(new FakeParticipant("s1", { id: "s1-mic", readyState: "live" }));
    room.remoteParticipants.get("s1")!.attributes.captionsAsr = "1";
    await render({ room, role: "teacher", teacherCaptionsOn: true, prefetchSession: true });
    const before = configCalls().length;
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ reason: "captions-off" }), { status: 403 }),
    );
    FakeRecognition.instances[0].final("hola");
    await settle();
    expect(configCalls().length).toBe(before + 1);
  });
});

describe("useBrowserCaptions — on-device models", () => {
  it("starts the translator downloads before the speech model, inside the call", async () => {
    const order: string[] = [];
    FakeRecognition.install = vi.fn(async (o: { langs: string[] }) => {
      order.push(`speech:${o.langs[0]}`);
      return true;
    }) as never;
    (window as unknown as Record<string, unknown>).Translator = {
      availability: vi.fn(async () => "downloadable"),
      create: vi.fn(async (o: { sourceLanguage: string; targetLanguage: string }) => {
        order.push(`translator:${o.sourceLanguage}-${o.targetLanguage}`);
        return { translate: async (t: string) => t };
      }),
    };
    const room = new FakeRoom("t1");
    await render({ room, role: "teacher", teacherCaptionsOn: false, prefetchSession: true });

    act(() => latest.prepareOnDevice());
    expect(order).toEqual(["translator:es-en", "translator:en-es", "speech:es-MX", "speech:en"]);
  });

  it("skips the student's models without her consent", async () => {
    configReplies = [
      { ok: true, enabled: true, session: SESSION("teacher", { studentConsent: false }) },
    ];
    const install = vi.fn(async () => true);
    FakeRecognition.install = install as never;
    const room = new FakeRoom("t1");
    await render({ room, role: "teacher", teacherCaptionsOn: false, prefetchSession: true });
    act(() => latest.prepareOnDevice());
    expect(
      install.mock.calls.map((c) => (c as unknown as [{ langs: string[] }])[0].langs[0]),
    ).toEqual(["es-MX"]);
  });

  it("does nothing before the session has arrived", async () => {
    const install = vi.fn(async () => true);
    FakeRecognition.install = install as never;
    const room = new FakeRoom("t1");
    await render({ room, role: "teacher", teacherCaptionsOn: false, prefetchSession: false });
    act(() => latest.prepareOnDevice());
    expect(install).not.toHaveBeenCalled();
  });
});
