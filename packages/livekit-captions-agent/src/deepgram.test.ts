import { describe, expect, it } from "vitest";
import {
  deepgramSocketUrl,
  finalTranscript,
  reconnectBackoffMs,
  segmentEndOffsetMs,
} from "./deepgram";

describe("deepgramSocketUrl", () => {
  it("bakes in the same nova-2 model as the client-driven design, plus linear16 PCM framing", () => {
    const url = new URL(deepgramSocketUrl("es"));
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("es");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
  });

  it("uses a 200ms endpointing threshold, deliberately drifted lower than the client-driven path's 300ms (2026-07-26 latency experiment)", () => {
    const url = new URL(deepgramSocketUrl("es"));
    expect(url.searchParams.get("endpointing")).toBe("200");
  });
});

describe("reconnectBackoffMs", () => {
  it("doubles each attempt starting from a 500ms base", () => {
    expect(reconnectBackoffMs(0)).toBe(500);
    expect(reconnectBackoffMs(1)).toBe(1000);
    expect(reconnectBackoffMs(2)).toBe(2000);
    expect(reconnectBackoffMs(3)).toBe(4000);
  });

  it("caps at 15s so a long outage doesn't back off indefinitely", () => {
    expect(reconnectBackoffMs(10)).toBe(15_000);
    expect(reconnectBackoffMs(20)).toBe(15_000);
  });
});

describe("finalTranscript", () => {
  it("returns the transcript text for a final segment", () => {
    expect(
      finalTranscript({
        is_final: true,
        channel: { alternatives: [{ transcript: "How are you?" }] },
      }),
    ).toBe("How are you?");
  });

  it("returns text for a speech_final segment too", () => {
    expect(
      finalTranscript({
        speech_final: true,
        channel: { alternatives: [{ transcript: "Hola" }] },
      }),
    ).toBe("Hola");
  });

  it("returns null for a non-final (interim) segment", () => {
    expect(
      finalTranscript({
        is_final: false,
        channel: { alternatives: [{ transcript: "How are" }] },
      }),
    ).toBeNull();
  });

  it("returns null for an empty/whitespace-only transcript", () => {
    expect(
      finalTranscript({ is_final: true, channel: { alternatives: [{ transcript: "   " }] } }),
    ).toBeNull();
    expect(finalTranscript({ is_final: true, channel: { alternatives: [] } })).toBeNull();
    expect(finalTranscript({ is_final: true })).toBeNull();
  });
});

describe("segmentEndOffsetMs", () => {
  it("converts start+duration (seconds) to milliseconds", () => {
    expect(segmentEndOffsetMs({ start: 3.42, duration: 1.02 })).toBe(4440);
  });

  it("handles a segment starting at the very beginning of the stream", () => {
    expect(segmentEndOffsetMs({ start: 0, duration: 0.5 })).toBe(500);
  });

  it("returns null when start is missing", () => {
    expect(segmentEndOffsetMs({ duration: 1.02 })).toBeNull();
  });

  it("returns null when duration is missing", () => {
    expect(segmentEndOffsetMs({ start: 3.42 })).toBeNull();
  });

  it("returns null when start/duration are not numbers", () => {
    expect(segmentEndOffsetMs({ start: "3.42", duration: 1.02 })).toBeNull();
    expect(segmentEndOffsetMs({ start: 3.42, duration: null })).toBeNull();
  });

  it("returns null for a non-finite value", () => {
    expect(segmentEndOffsetMs({ start: Infinity, duration: 1 })).toBeNull();
    expect(segmentEndOffsetMs({ start: NaN, duration: 1 })).toBeNull();
  });
});
