import WebSocket from "ws";

// Server-side Deepgram streaming ASR. Mirrors apps/web/src/lib/captions/
// deepgram-token.ts's socket-URL params (same nova-2 model, same
// interim_results config) but authenticates directly with the long-lived
// DEEPGRAM_API_KEY (Authorization: Token header) instead of that file's
// short-lived-grant dance, which exists purely because a BROWSER can't hold
// the long-lived key — a server-side Agent has no such constraint.
//
// Unlike the client-driven version, this reconnects with backoff on an
// unexpected close — the old design's #1 reliability gap ("captions
// sometimes just stop") was exactly the absence of this.
//
// endpointing was deliberately lowered from 300ms (2026-07-26): real
// utterance_timing data from the live class-call Agent showed a bimodal
// ASR-finalization latency (~100-150ms typical, two outliers at 800ms+ out of
// 6 samples) — 200ms is an experiment to cut that tail, trading off
// more/choppier segment splits on mid-sentence pauses.

const DEEPGRAM_STREAM_HOST = "wss://api.deepgram.com";

export function deepgramSocketUrl(language: string): string {
  const params = new URLSearchParams({
    model: "nova-2",
    language,
    smart_format: "true",
    interim_results: "true",
    endpointing: "200",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });
  return `${DEEPGRAM_STREAM_HOST}/v1/listen?${params.toString()}`;
}

// Exponential backoff with a cap, pure and unit-testable independent of any
// real socket. attempt is 0-indexed (first reconnect attempt = 0).
export function reconnectBackoffMs(attempt: number): number {
  const base = 500;
  const cap = 15_000;
  return Math.min(cap, base * 2 ** attempt);
}

type DeepgramMessage = {
  channel?: { alternatives?: Array<{ transcript?: unknown }> };
  is_final?: unknown;
  speech_final?: unknown;
  // Audio-stream-relative offsets in seconds (Deepgram's own clock, zeroed at
  // the start of THIS websocket session) — start of this segment and its
  // duration. Used to recover the real end-of-speech wall-clock moment for
  // ASR-latency instrumentation (see segmentEndOffsetMs below); has nothing
  // to do with is_final/the transcript text itself.
  start?: unknown;
  duration?: unknown;
};

// Pull a finalized transcript out of a Deepgram streaming message, or null if
// this message isn't a final segment with text. Identical logic to the
// client-driven version's finalTranscript() (apps/web/src/lib/captions/
// use-live-captions.ts) — same wire shape, same vendor, deliberately kept in
// sync rather than imported (this package doesn't depend on apps/web).
export function finalTranscript(msg: DeepgramMessage): string | null {
  const isFinal = msg.is_final === true || msg.speech_final === true;
  if (!isFinal) return null;
  const alt = msg.channel?.alternatives?.[0];
  const text = typeof alt?.transcript === "string" ? alt.transcript.trim() : "";
  return text.length > 0 ? text : null;
}

// Milliseconds from the start of the audio stream to the END of this
// segment (start + duration), or null if either field is missing/not a
// finite number. Combined with when the websocket opened, this recovers the
// real wall-clock moment speech ended — the actual quantity "how long after
// I stop talking does captioning appear" needs, as opposed to measuring from
// whenever this process happened to receive+parse the message.
export function segmentEndOffsetMs(msg: DeepgramMessage): number | null {
  const start = typeof msg.start === "number" ? msg.start : null;
  const duration = typeof msg.duration === "number" ? msg.duration : null;
  if (start == null || duration == null || !Number.isFinite(start) || !Number.isFinite(duration)) {
    return null;
  }
  return Math.round((start + duration) * 1000);
}

export type DeepgramStreamHandlers = {
  // audioEndAtMs is the real wall-clock ms (Date.now() epoch) speech ended,
  // when Deepgram's start/duration were present on this message — null if
  // they were missing (caller should fall back to Date.now() at receipt).
  onFinalTranscript: (text: string, audioEndAtMs: number | null) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
};

// A long-lived, self-reconnecting Deepgram streaming session for one
// participant's audio. `send(pcm)` is a no-op while reconnecting — a few
// dropped frames during a reconnect window is an acceptable trade for
// continuing to caption the call at all, matching this repo's general
// "best-effort, one dropped line isn't fatal" caption philosophy.
export class DeepgramStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Wall-clock moment THIS websocket session opened — Deepgram's start/
  // duration fields are relative to it, and it resets on every reconnect
  // (a new session, a new zero point).
  private streamOpenedAt: number | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly language: string,
    private readonly handlers: DeepgramStreamHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(deepgramSocketUrl(this.language), {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.streamOpenedAt = Date.now();
      this.handlers.onOpen?.();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(data.toString()) as DeepgramMessage;
      } catch {
        return;
      }
      const text = finalTranscript(msg);
      if (!text) return;
      const offsetMs = segmentEndOffsetMs(msg);
      const audioEndAtMs =
        offsetMs != null && this.streamOpenedAt != null ? this.streamOpenedAt + offsetMs : null;
      this.handlers.onFinalTranscript(text, audioEndAtMs);
    });

    ws.on("error", (err) => {
      this.handlers.onError?.(err);
    });

    ws.on("close", () => {
      if (this.closed) return;
      const delay = reconnectBackoffMs(this.reconnectAttempt++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  // Send one PCM frame (linear16, 16kHz, mono — see @livekit/rtc-node's
  // AudioStream constructed with that exact sample rate/channel count, so no
  // resampling happens here).
  send(pcm: Int16Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
