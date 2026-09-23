import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  IMMEDIATE_RESTART_MS,
  afterRecognitionEnd,
  backoffDelay,
  isFailure,
  type RecognitionEnd,
} from "@/lib/captions/recognition-policy";

const end = (over: Partial<RecognitionEnd> = {}): RecognitionEnd => ({
  error: null,
  consecutiveFailures: 0,
  local: false,
  canFallBackToBareLanguage: false,
  ...over,
});

describe("afterRecognitionEnd", () => {
  // The normal rhythm of a lesson: silence ends a session and the next starts.
  it("restarts at once after a quiet end, a no-speech end or an abort", () => {
    for (const error of [null, "no-speech", "aborted"]) {
      expect(afterRecognitionEnd(end({ error }))).toEqual({
        kind: "restart",
        delayMs: IMMEDIATE_RESTART_MS,
      });
    }
  });

  it("backs off on network and audio-capture failures", () => {
    expect(afterRecognitionEnd(end({ error: "network", consecutiveFailures: 1 }))).toEqual({
      kind: "restart",
      delayMs: 1_000,
    });
    expect(afterRecognitionEnd(end({ error: "audio-capture", consecutiveFailures: 3 }))).toEqual({
      kind: "restart",
      delayMs: 4_000,
    });
  });

  it("stops for good when the microphone permission is refused", () => {
    expect(afterRecognitionEnd(end({ error: "not-allowed" }))).toEqual({
      kind: "stop",
      reason: "permission",
    });
  });

  it("drops on-device recognition when the local model refuses the language", () => {
    for (const error of ["language-not-supported", "service-not-allowed"]) {
      expect(afterRecognitionEnd(end({ error, local: true }))).toMatchObject({
        kind: "restart-remote",
      });
    }
  });

  it("drops on-device recognition when it keeps failing for any reason", () => {
    expect(
      afterRecognitionEnd(end({ error: "network", local: true, consecutiveFailures: 2 })),
    ).toMatchObject({ kind: "restart-remote" });
    expect(
      afterRecognitionEnd(end({ error: "network", local: true, consecutiveFailures: 1 })),
    ).toMatchObject({ kind: "restart" });
  });

  it("retries a regional language as the bare language before giving up", () => {
    expect(
      afterRecognitionEnd(
        end({ error: "language-not-supported", canFallBackToBareLanguage: true }),
      ),
    ).toMatchObject({ kind: "restart-bare-language" });
    expect(afterRecognitionEnd(end({ error: "language-not-supported" }))).toEqual({
      kind: "stop",
      reason: "unsupported",
    });
    expect(afterRecognitionEnd(end({ error: "service-not-allowed" }))).toEqual({
      kind: "stop",
      reason: "permission",
    });
  });
});

describe("backoffDelay", () => {
  it("doubles from one second and caps at half a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(100)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(0)).toBe(1_000);
  });
});

describe("isFailure", () => {
  it("does not count silence or aborts as failures", () => {
    expect(isFailure(null)).toBe(false);
    expect(isFailure("no-speech")).toBe(false);
    expect(isFailure("aborted")).toBe(false);
    expect(isFailure("network")).toBe(true);
  });
});
