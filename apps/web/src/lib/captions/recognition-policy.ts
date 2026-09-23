// What a live-caption recogniser does when a recognition session ends (D-185).
//
// Browser SpeechRecognition is not a stream that runs for an hour: Chrome
// ends a "continuous" session after a stretch of silence, after a network
// blip, or for no stated reason at all, and the caller is expected to start
// another. This is the pure decision behind that loop, separated from the
// browser wiring (recognizer.ts) so every branch is testable in node.
//
// Measured while building this (Chrome 153, desktop): a restart issued from
// inside `onend` can throw, and if nothing catches it the loop silently
// stops — no error, no captions, for the rest of the class. So a restart is
// always a FRESH SpeechRecognition instance, and every failure to start is
// just another failure that this policy schedules a retry for.

// The SpeechRecognitionErrorEvent.error values the policy distinguishes;
// anything else is treated like a transient failure.
export type RecognitionErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "language-not-supported"
  | "bad-grammar"
  | (string & {});

export type RecognitionEnd = {
  // The error that preceded this end, if any. A session that simply ran out
  // of speech ends with no error, or with "no-speech".
  error: RecognitionErrorCode | null;
  // Failures in a row with no result in between, INCLUDING this one when it
  // is a failure. Reset by the caller whenever a result arrives.
  consecutiveFailures: number;
  // Whether this session asked for on-device recognition.
  local: boolean;
  // Whether the recognition language is regional ("es-MX") and has not yet
  // been retried as the bare language ("es").
  canFallBackToBareLanguage: boolean;
};

export type RecognitionAction =
  | { kind: "restart"; delayMs: number }
  // Retry without on-device recognition: the local model refused this
  // language or is not usable, and the browser's service may still work.
  | { kind: "restart-remote"; delayMs: number }
  // Retry as the bare language: the regional variant is not one this
  // browser's recogniser offers.
  | { kind: "restart-bare-language"; delayMs: number }
  // Stop for good and tell the user: retrying cannot help.
  | { kind: "stop"; reason: "permission" | "unsupported" };

// A silent stretch or a deliberate abort ends a session routinely; the next
// one starts at once. The short pause keeps a browser that ends sessions
// instantly (a revoked device, say) from spinning a CPU core.
export const IMMEDIATE_RESTART_MS = 250;
// Backoff for failures that say something is wrong right now — the network,
// the audio device — doubling from one second to half a minute.
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export function backoffDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

export function afterRecognitionEnd(end: RecognitionEnd): RecognitionAction {
  switch (end.error) {
    case null:
    case "no-speech":
    case "aborted":
      return { kind: "restart", delayMs: IMMEDIATE_RESTART_MS };
    case "not-allowed":
      // The microphone permission, or the page's permission to recognise at
      // all. A retry would fail identically and, worse, might prompt again.
      return { kind: "stop", reason: "permission" };
    case "service-not-allowed":
    case "language-not-supported":
      if (end.local) return { kind: "restart-remote", delayMs: IMMEDIATE_RESTART_MS };
      if (end.canFallBackToBareLanguage) {
        return { kind: "restart-bare-language", delayMs: IMMEDIATE_RESTART_MS };
      }
      return end.error === "service-not-allowed"
        ? { kind: "stop", reason: "permission" }
        : { kind: "stop", reason: "unsupported" };
    default:
      // On-device recognition fed a call track is the one combination not
      // measured on a real call. If it keeps failing, give the browser's
      // service the job rather than retrying the same thing all class.
      if (end.local && end.consecutiveFailures >= LOCAL_FAILURES_BEFORE_REMOTE) {
        return { kind: "restart-remote", delayMs: backoffDelay(end.consecutiveFailures) };
      }
      return { kind: "restart", delayMs: backoffDelay(end.consecutiveFailures) };
  }
}

export const LOCAL_FAILURES_BEFORE_REMOTE = 2;

// Whether an end counts as a failure for the backoff counter. A session that
// ended because nobody spoke is the normal rhythm of a lesson, not a fault.
export function isFailure(error: RecognitionErrorCode | null): boolean {
  return error !== null && error !== "no-speech" && error !== "aborted";
}
