import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HEALTHY_MS,
  CLOUD_MAX_FAILURES,
  CLOUD_TIMESLICE_MS,
  CloudRecognizer,
  finalTranscriptOf,
  pickCloudMimeType,
  type CloudRecognizerOptions,
  type MediaRecorderCtorLike,
  type WebSocketCtorLike,
} from "@/lib/captions/cloud-recognizer";

// The phone-to-phone fallback's streaming client (D-185's addendum), against
// a fake WebSocket, MediaRecorder, token route and clock: it opens the socket
// with the token as the bearer subprotocol, records the call's own mic track
// into it, passes on finals only, reconnects with backoff on a fresh token,
// gives up when retrying cannot help, and stops cleanly.

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // Test drivers.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  static isTypeSupported = (t: string) => FakeRecorder.supported.has(t);
  state = "inactive";
  timeslice: number | undefined;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string },
  ) {
    FakeRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop() {
    this.state = "inactive";
  }
  emit(size: number) {
    this.ondataavailable?.({ data: { size } as Blob });
  }
}

const track = { id: "mic", readyState: "live" } as MediaStreamTrack;

type Timer = { fn: () => void; ms: number; cleared: boolean };
let timers: Timer[];
let clock: number;
let tokenReplies: (() => Response | Error)[];
const tokenFetch = vi.fn(async (_u: string | URL | Request, _init?: RequestInit) => {
  const next = tokenReplies.shift() ?? (() => grant());
  const r = next();
  if (r instanceof Error) throw r;
  return r;
});

function grant(n = 1) {
  return new Response(
    JSON.stringify({ ok: true, token: `jwt-${n}`, url: "wss://api.deepgram.com/v1/listen?x=1" }),
    { status: 200 },
  );
}
const refuse =
  (status: number, body: Record<string, unknown> = {}) =>
  () =>
    new Response(JSON.stringify({ ok: false, ...body }), { status });

function setup(over: Partial<CloudRecognizerOptions> = {}) {
  const finals: string[] = [];
  const stopped: string[] = [];
  const onRefused = vi.fn();
  const r = new CloudRecognizer({
    bookingId: "b1",
    track,
    fetch: tokenFetch as unknown as typeof fetch,
    WebSocket: FakeSocket as unknown as WebSocketCtorLike,
    MediaRecorder: FakeRecorder as unknown as MediaRecorderCtorLike,
    onFinal: (t) => finals.push(t),
    onStopped: (reason) => stopped.push(reason),
    onRefused,
    createStream: (t) => ({ tracks: [t] }) as unknown as MediaStream,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as Timer).cleared = true;
    },
    now: () => clock,
    ...over,
  });
  return { r, finals, stopped, onRefused };
}

// Real ticks: Response.json() in Node crosses a macrotask.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0));
};
const socket = () => FakeSocket.instances.at(-1) as FakeSocket;
const recorder = () => FakeRecorder.instances.at(-1) as FakeRecorder;
const pending = () => timers.filter((t) => !t.cleared);
async function fireTimer() {
  const t = pending().shift() as Timer;
  t.cleared = true;
  t.fn();
  await flush();
}
const result = (transcript: string, isFinal = true) =>
  JSON.stringify({
    type: "Results",
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  });

beforeEach(() => {
  FakeSocket.instances = [];
  FakeRecorder.instances = [];
  FakeRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  timers = [];
  clock = 0;
  tokenReplies = [];
  tokenFetch.mockClear();
});

describe("CloudRecognizer — connecting and streaming", () => {
  it("asks the token route for this class, then opens the socket with the bearer token", async () => {
    const { r } = setup();
    r.start();
    await flush();
    const [url, init] = tokenFetch.mock.calls[0];
    expect(url).toBe("/api/captions/stt-token");
    expect(JSON.parse(String(init?.body))).toEqual({ bookingId: "b1" });
    expect(socket().url).toBe("wss://api.deepgram.com/v1/listen?x=1");
    expect(socket().protocols).toEqual(["bearer", "jwt-1"]);
  });

  it("records the call's own track as WebM/Opus once the socket opens, and sends each chunk", async () => {
    const { r } = setup();
    r.start();
    await flush();
    expect(FakeRecorder.instances).toHaveLength(0);
    socket().open();
    expect(recorder().options.mimeType).toBe("audio/webm;codecs=opus");
    expect((recorder().stream as { tracks: unknown[] }).tracks).toEqual([track]);
    expect(recorder().timeslice).toBe(CLOUD_TIMESLICE_MS);
    recorder().emit(120);
    recorder().emit(0);
    expect(socket().sent).toHaveLength(1);
  });

  it("passes on finals only", async () => {
    const { r, finals } = setup();
    r.start();
    await flush();
    socket().open();
    socket().message(result("hola a todos"));
    socket().message(result("parcial", false));
    socket().message(result("   "));
    socket().message(JSON.stringify({ type: "Metadata" }));
    socket().message("not json");
    expect(finals).toEqual(["hola a todos"]);
  });
});

describe("CloudRecognizer — reconnecting", () => {
  it("reconnects with a fresh token and a fresh recorder after a drop, backing off", async () => {
    const { r } = setup();
    tokenReplies = [() => grant(1), () => grant(2)];
    r.start();
    await flush();
    socket().open();
    const first = recorder();
    socket().drop();
    expect(first.state).toBe("inactive");
    expect(pending().map((t) => t.ms)).toEqual([1_000]);
    await fireTimer();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(socket().protocols).toEqual(["bearer", "jwt-2"]);
    socket().open();
    expect(FakeRecorder.instances).toHaveLength(2);
  });

  it("doubles the backoff on consecutive failures and gives up after the cap", async () => {
    const { r, stopped } = setup();
    r.start();
    await flush();
    const delays: number[] = [];
    for (let i = 1; i < CLOUD_MAX_FAILURES; i++) {
      socket().drop();
      delays.push(pending()[0].ms);
      await fireTimer();
    }
    socket().drop();
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(stopped).toEqual(["unavailable"]);
    expect(pending()).toHaveLength(0);
  });

  it("forgives earlier failures once a connection has stayed up", async () => {
    const { r } = setup();
    r.start();
    await flush();
    socket().drop();
    await fireTimer();
    socket().drop();
    await fireTimer();
    socket().open();
    clock += CLOUD_HEALTHY_MS;
    socket().drop();
    expect(pending()[0].ms).toBe(1_000);
  });

  it("retries a network failure or a 5xx from the token route", async () => {
    const { r } = setup();
    tokenReplies = [() => new Error("offline"), refuse(502, { reason: "grant-failed" })];
    r.start();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    await fireTimer();
    expect(FakeSocket.instances).toHaveLength(0);
    await fireTimer();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("waits out a rate limit for as long as the route says", async () => {
    const { r } = setup();
    tokenReplies = [refuse(429, { reason: "rate-limited", retryAfterMs: 45_000 })];
    r.start();
    await flush();
    expect(pending()[0].ms).toBe(45_000);
  });

  it("looks again later when the room does not need the fallback yet", async () => {
    const { r, stopped } = setup();
    tokenReplies = [refuse(409, { reason: "not-warranted" })];
    r.start();
    await flush();
    expect(pending()[0].ms).toBe(5_000);
    expect(stopped).toEqual([]);
  });
});

describe("CloudRecognizer — giving up", () => {
  it("gives up as unsupported on a language the service cannot stream", async () => {
    const { r, stopped } = setup();
    tokenReplies = [refuse(422, { reason: "unsupported-language" })];
    r.start();
    await flush();
    expect(stopped).toEqual(["unsupported"]);
    expect(pending()).toHaveLength(0);
  });

  it("passes a refusal up and gives up, never retrying it", async () => {
    const { r, stopped, onRefused } = setup();
    tokenReplies = [refuse(403, { reason: "no-consent" })];
    r.start();
    await flush();
    expect(onRefused).toHaveBeenCalledWith("no-consent");
    expect(stopped).toEqual(["unavailable"]);
    expect(pending()).toHaveLength(0);
  });

  it("gives up without a refusal on another 4xx", async () => {
    const { r, stopped, onRefused } = setup();
    tokenReplies = [refuse(403, { reason: "cloud-off" })];
    r.start();
    await flush();
    expect(onRefused).not.toHaveBeenCalled();
    expect(stopped).toEqual(["unavailable"]);
  });

  it("gives up as unsupported, before asking for a token, when it cannot record", async () => {
    FakeRecorder.supported = new Set(["audio/mp4"]);
    const { r, stopped } = setup();
    r.start();
    await flush();
    expect(stopped).toEqual(["unsupported"]);
    expect(tokenFetch).not.toHaveBeenCalled();

    const noRecorder = setup({ MediaRecorder: null });
    noRecorder.r.start();
    await flush();
    expect(noRecorder.stopped).toEqual(["unsupported"]);
    const noSocket = setup({ WebSocket: null });
    noSocket.r.start();
    await flush();
    expect(noSocket.stopped).toEqual(["unsupported"]);
  });
});

describe("CloudRecognizer — stopping", () => {
  it("ends the stream cleanly: recorder stopped, CloseStream sent, socket closed", async () => {
    const { r, finals, stopped } = setup();
    r.start();
    await flush();
    socket().open();
    const s = socket();
    r.stop();
    expect(recorder().state).toBe("inactive");
    expect(s.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    expect(s.closedWith).toBe(1000);
    // Nothing after a stop: no finals, no reconnect, no give-up report.
    s.message(result("tarde"));
    s.drop();
    expect(finals).toEqual([]);
    expect(pending()).toHaveLength(0);
    expect(stopped).toEqual([]);
  });

  it("cancels a pending reconnect", async () => {
    const { r } = setup();
    r.start();
    await flush();
    socket().drop();
    r.stop();
    expect(pending()).toHaveLength(0);
  });

  it("opens no socket when stopped while the token was on its way", async () => {
    const { r } = setup();
    r.start();
    r.stop();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("ignores a second start", async () => {
    const { r } = setup();
    r.start();
    r.start();
    await flush();
    expect(tokenFetch).toHaveBeenCalledTimes(1);
  });

  it("closes the socket, and retries, when the recorder cannot start", async () => {
    class Broken extends FakeRecorder {
      override start(): void {
        throw new Error("track ended");
      }
    }
    const { r } = setup({ MediaRecorder: Broken as unknown as MediaRecorderCtorLike });
    r.start();
    await flush();
    const s = socket();
    s.open();
    expect(s.readyState).toBe(3);
  });
});

describe("pickCloudMimeType / finalTranscriptOf", () => {
  it("prefers WebM/Opus, falls back to Ogg/Opus, and answers null otherwise", () => {
    expect(pickCloudMimeType(FakeRecorder as unknown as MediaRecorderCtorLike)).toBe(
      "audio/webm;codecs=opus",
    );
    FakeRecorder.supported = new Set(["audio/ogg;codecs=opus"]);
    expect(pickCloudMimeType(FakeRecorder as unknown as MediaRecorderCtorLike)).toBe(
      "audio/ogg;codecs=opus",
    );
    expect(pickCloudMimeType(null)).toBeNull();
    expect(pickCloudMimeType(function R() {} as unknown as MediaRecorderCtorLike)).toBeNull();
  });

  it("reads only a final Results message's first alternative", () => {
    expect(finalTranscriptOf(result(" hola "))).toBe("hola");
    expect(finalTranscriptOf(result("hola", false))).toBeNull();
    expect(finalTranscriptOf(JSON.stringify({ type: "Results", is_final: true }))).toBeNull();
    expect(finalTranscriptOf(new ArrayBuffer(2))).toBeNull();
  });
});
