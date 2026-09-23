import type { TranslationRefusal } from "@/lib/captions/caption-translator";
import type { RecognizerStopReason } from "@/lib/captions/recognizer";

// Live captions' phone-to-phone fallback, in the browser (D-185's addendum).
// When no browser in the class can recognise speech — Android Chrome hears
// nothing while the call holds the microphone, measured — the speaker's own
// browser records the call's OWN microphone track with MediaRecorder and
// streams it to Deepgram over a WebSocket, turning each final transcript into
// the same onFinal a browser recogniser produces. The controller then
// translates and publishes it exactly as it does any other line.
//
// It records the LiveKit track, never a second getUserMedia capture, so the
// call's audio is untouched and muting the call mutes what is streamed.
//
// Each connection starts with POST /api/captions/stt-token, which checks the
// room really needs the fallback and returns a short-lived token and the
// listen URL (model and language chosen by the server). A connection that
// drops is reopened with a fresh token after a backoff; one that keeps
// failing gives up rather than spending the route's budget in a loop.

// The slices of the browser APIs this uses, declared here so a test can hand
// in fakes and the file compiles whatever lib.dom version is installed.
export type WebSocketLike = {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: Blob | string): void;
  close(code?: number): void;
};
export type WebSocketCtorLike = new (url: string, protocols: string[]) => WebSocketLike;

export type MediaRecorderLike = {
  readonly state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
};
export type MediaRecorderCtorLike = {
  new (stream: MediaStream, options: { mimeType: string }): MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
};

export type CloudRecognizerOptions = {
  bookingId: string;
  // The speaker's own LiveKit microphone track.
  track: MediaStreamTrack;
  fetch: typeof fetch;
  WebSocket: WebSocketCtorLike | null;
  MediaRecorder: MediaRecorderCtorLike | null;
  onFinal: (text: string) => void;
  // Called once, when the recogniser gives up for good.
  onStopped: (reason: RecognizerStopReason) => void;
  // The server refused for a reason retrying cannot fix (consent revoked,
  // captions switched off, a plan downgraded); the caller re-reads the config.
  onRefused: (reason: TranslationRefusal) => void;
  createStream?: (track: MediaStreamTrack) => MediaStream;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
};

// Opus in a WebM container is what Chrome (Android included) records, and
// Deepgram detects a containerised stream without being told the encoding.
// Ogg/Opus is Firefox's. A browser that can record neither gives up rather
// than send Deepgram something it will reject.
export const CLOUD_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

// Small enough that a phrase reaches Deepgram as it is spoken, large enough
// not to flood a phone's uplink with tiny frames.
export const CLOUD_TIMESLICE_MS = 250;

// Reconnects back off 1 s, 2 s, 4 s … up to this, and after this many
// consecutive failed attempts the recogniser gives up. A connection that
// stayed up long enough to be healthy resets the count.
export const CLOUD_MAX_BACKOFF_MS = 30_000;
export const CLOUD_MAX_FAILURES = 6;
export const CLOUD_HEALTHY_MS = 30_000;
// The server said the room does not need the fallback (a capable browser
// joined, or its attribute has not propagated yet): look again after this.
const NOT_WARRANTED_RETRY_MS = 5_000;

const WS_OPEN = 1;

const REFUSALS: readonly string[] = ["captions-off", "no-consent", "not-entitled", "not-found"];

type TokenAnswer =
  | { kind: "token"; token: string; url: string }
  | { kind: "retry"; afterMs: number | null }
  | { kind: "give-up"; reason: RecognizerStopReason; refusal?: TranslationRefusal };

export function pickCloudMimeType(Recorder: MediaRecorderCtorLike | null): string | null {
  if (!Recorder || typeof Recorder.isTypeSupported !== "function") return null;
  return CLOUD_MIME_TYPES.find((t) => Recorder.isTypeSupported?.(t)) ?? null;
}

// One Deepgram message → the final transcript it carries, or null. Only
// "Results" messages marked final count; metadata, speech-started and
// utterance-end messages, interim results and empty finals are all ignored.
export function finalTranscriptOf(data: unknown): string | null {
  if (typeof data !== "string") return null;
  let msg: {
    type?: unknown;
    is_final?: unknown;
    channel?: { alternatives?: { transcript?: unknown }[] };
  };
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg?.type !== "Results" || msg.is_final !== true) return null;
  const transcript = msg.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") return null;
  const text = transcript.trim();
  return text || null;
}

export class CloudRecognizer {
  private readonly opts: Required<CloudRecognizerOptions>;
  private running = false;
  private ws: WebSocketLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private timer: unknown = null;
  private failures = 0;
  private openedAt: number | null = null;

  constructor(options: CloudRecognizerOptions) {
    this.opts = {
      createStream: (track) => new MediaStream([track]),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
      now: Date.now,
      ...options,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.opts.clearTimeout(this.timer);
    this.timer = null;
    this.teardown(true);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const mimeType = pickCloudMimeType(this.opts.MediaRecorder);
    if (!mimeType || !this.opts.WebSocket) {
      this.giveUp("unsupported");
      return;
    }

    const answer = await this.requestToken();
    if (!this.running) return;
    if (answer.kind === "give-up") {
      if (answer.refusal) this.opts.onRefused(answer.refusal);
      this.giveUp(answer.reason);
      return;
    }
    if (answer.kind === "retry") {
      this.failed(answer.afterMs);
      return;
    }

    let ws: WebSocketLike;
    try {
      // A browser cannot set an Authorization header on a WebSocket; Deepgram
      // takes a grant token as the subprotocol pair ["bearer", token].
      ws = new this.opts.WebSocket(answer.url, ["bearer", answer.token]);
    } catch {
      this.failed(null);
      return;
    }
    this.ws = ws;
    this.openedAt = null;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedAt = this.opts.now();
      this.startRecording(ws, mimeType);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      const text = finalTranscriptOf(event.data);
      if (text) this.opts.onFinal(text);
    };
    ws.onerror = () => {
      // Always followed by onclose, which decides what happens next.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const healthy = this.openedAt !== null && this.opts.now() - this.openedAt >= CLOUD_HEALTHY_MS;
      this.teardown(false);
      if (!this.running) return;
      if (healthy) this.failures = 0;
      this.failed(null);
    };
  }

  private startRecording(ws: WebSocketLike, mimeType: string): void {
    const Recorder = this.opts.MediaRecorder as MediaRecorderCtorLike;
    try {
      // A fresh recorder per connection: a WebM stream's header is only in
      // its first chunk, and Deepgram needs it at the start of every socket.
      const recorder = new Recorder(this.opts.createStream(this.opts.track), { mimeType });
      recorder.ondataavailable = (event) => {
        if (ws.readyState === WS_OPEN && event.data.size > 0) ws.send(event.data);
      };
      recorder.start(CLOUD_TIMESLICE_MS);
      this.recorder = recorder;
    } catch {
      // The track ended, or the browser refused this recorder: close, and let
      // onclose schedule the retry (or the controller replace the track).
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }
  }

  private async requestToken(): Promise<TokenAnswer> {
    let res: Response;
    try {
      res = await this.opts.fetch("/api/captions/stt-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: this.opts.bookingId }),
      });
    } catch {
      return { kind: "retry", afterMs: null };
    }
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      url?: unknown;
      reason?: unknown;
      retryAfterMs?: unknown;
    } | null;
    if (res.ok && typeof body?.token === "string" && typeof body.url === "string") {
      return { kind: "token", token: body.token, url: body.url };
    }
    if (res.status === 409) return { kind: "retry", afterMs: NOT_WARRANTED_RETRY_MS };
    if (res.status === 429) {
      const after = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
      return { kind: "retry", afterMs: after };
    }
    if (res.status === 422) return { kind: "give-up", reason: "unsupported" };
    if (res.status >= 400 && res.status < 500) {
      const reason = typeof body?.reason === "string" ? body.reason : "";
      return {
        kind: "give-up",
        reason: "unavailable",
        ...(REFUSALS.includes(reason) ? { refusal: reason as TranslationRefusal } : {}),
      };
    }
    // 5xx: our server, LiveKit or Deepgram having a moment.
    return { kind: "retry", afterMs: null };
  }

  // One more consecutive failure: retry after a backoff, or give up.
  private failed(afterMs: number | null): void {
    this.failures += 1;
    if (this.failures >= CLOUD_MAX_FAILURES) {
      this.giveUp("unavailable");
      return;
    }
    const backoff = Math.min(1_000 * 2 ** (this.failures - 1), CLOUD_MAX_BACKOFF_MS);
    this.timer = this.opts.setTimeout(
      () => {
        this.timer = null;
        void this.connect();
      },
      Math.max(backoff, afterMs ?? 0),
    );
  }

  private giveUp(reason: RecognizerStopReason): void {
    if (!this.running) return;
    this.stop();
    this.opts.onStopped(reason);
  }

  // Stop recording and close the socket. `graceful` first sends Deepgram's
  // documented end-of-stream message (CloseStream), so a stop we chose reads
  // as a clean finish on Deepgram's side rather than a dropped connection.
  private teardown(graceful: boolean): void {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    const ws = this.ws;
    this.ws = null;
    this.openedAt = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      if (graceful && ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close(1000);
    } catch {
      // Already closed.
    }
  }
}
