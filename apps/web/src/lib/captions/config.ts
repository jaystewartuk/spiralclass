import { logger } from "@/lib/logger";

// Live in-class captions config + availability gate (D-27, D-185).
//
// Captions run in the participants' browsers (D-185): each direction of speech
// is recognised by a browser's own SpeechRecognition — the speaker's, or the
// other participant's when the speaker's device cannot (see
// @spiralclass/shared caption-recognition.ts) — and translated on that device
// where the browser has a translator, otherwise by POST /api/captions/translate
// through Google Cloud Translation. The finished line is published into the
// LiveKit room for the other side to render. Nothing is stored — captions are
// ephemeral and never persisted.
//
// Two independent conditions must BOTH hold before the feature is offered:
//   1. The server fallback is configured: GOOGLE_TRANSLATE_API_KEY. Only
//      desktop Chrome translates on the device, so without the key most
//      pairs of devices would caption nothing; the toggle stays hidden rather
//      than offering a feature that works for some classes and silently not
//      for others.
//   2. The explicit enablement flag (LIVE_CAPTIONS_ENABLED) is on. Sending a
//      live lesson's speech to a browser vendor's recogniser and a translation
//      service carries the same privacy/consent weight as the transcription
//      pipeline (D-21/D-22) — the code can ship and the key can be set while
//      the switch stays off.
//
// Keys are read straight from process.env (like provider.ts / transcription
// config) so an availability check never depends on the whole env schema
// validating — a page can ask "are captions available?" without every unrelated
// var being present.

const log = logger({ surface: "captions" });

// Trim + strip one layer of accidentally-wrapped quotes (a copy-paste mistake
// from a .env-style snippet — pasting `KEY="abc"` verbatim into an env-var UI
// field). Shared by every vendor-key reader in this module so the fix lives in
// one place; a quote-wrapped key is rejected by the vendor as malformed, which
// reads as "configured but broken" rather than "not configured".
function sanitizeApiKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoted =
    trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

// Read + sanitize the Deepgram key from the raw environment. Every reader of
// DEEPGRAM_API_KEY (transcription/config.ts) goes through here so
// the fix below lives in exactly one place. Some env-var UIs make it easy to
// accidentally paste a value WITH its surrounding quotes (copying `KEY="abc"`
// verbatim out of a .env-style snippet) — Deepgram then sees a malformed
// token that fails basic validation outright, surfacing as a 400 Bad Request
// rather than the 401/403 an actually-wrong-but-well-formed key would
// produce, which reads as "still broken" even after fixing the key's actual
// permissions.
export function deepgramApiKey(): string | undefined {
  return sanitizeApiKey(process.env.DEEPGRAM_API_KEY);
}

// The Google Cloud Translation key the server fallback calls with — an API
// key restricted to that one API. Sanitized like every key in this module.
export function googleTranslateApiKey(): string | undefined {
  return sanitizeApiKey(process.env.GOOGLE_TRANSLATE_API_KEY);
}

// Is the server-side translation fallback configured?
export function captionsConfigured(): boolean {
  return Boolean(googleTranslateApiKey());
}

// Is the phone-to-phone fallback configured — the paid streaming
// speech-to-text a speaker's own browser uses when no browser in the class
// can recognise (D-185's addendum)? Not a condition of the feature: without
// it, two phones get a "needs a computer" notice instead of captions, exactly
// as before the fallback existed. The key is the one post-class transcription
// already uses, so it is normally present wherever captions are on.
export function cloudCaptionsConfigured(): boolean {
  return Boolean(deepgramApiKey());
}

function enablementFlagOn(): boolean {
  const raw = process.env.LIVE_CAPTIONS_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// Per-dependency readiness of the live-caption feature — booleans only, NEVER
// the secret values. `missing` names the env var(s) a flagged-on-but-dark
// deployment still needs. Read straight from process.env like the rest of this
// module, so it works even if the full env schema wouldn't validate.
//
// This exists because the failure it surfaces is otherwise invisible: when the
// flag is on but the key is absent, liveCaptionsEnabled() returns false, the
// teacher's toggle is hidden and the caption routes answer "disabled" with no
// logged reason. That is exactly the shape of the Vercel→Fly cutover (D-70)
// regression, when a vendor key set on one platform was not carried to the
// next and captions went dark with nothing in the logs to point at it.
export type CaptionsReadiness = {
  flagOn: boolean;
  googleTranslate: boolean;
  enabled: boolean;
  missing: string[];
};

export function captionsReadiness(): CaptionsReadiness {
  const flagOn = enablementFlagOn();
  const googleTranslate = captionsConfigured();
  const missing = googleTranslate ? [] : ["GOOGLE_TRANSLATE_API_KEY"];
  return { flagOn, googleTranslate, enabled: flagOn && googleTranslate, missing };
}

// One structured warning per process when the operator has switched captions ON
// but the key is missing, so a dark feature is diagnosable from the logs instead
// of silent. Once-guarded (not per-request) so it reads as a boot signal on a
// persistent server rather than log spam. No-op when captions are correctly
// configured, or correctly off.
let warnedMisconfig = false;
export function warnIfCaptionsMisconfigured(): void {
  if (warnedMisconfig) return;
  const readiness = captionsReadiness();
  if (readiness.flagOn && !readiness.enabled) {
    warnedMisconfig = true;
    log.warn(
      "LIVE_CAPTIONS_ENABLED is on but a required key is missing — captions stay dark (teacher toggle hidden, caption routes answer disabled). Set the missing key where the deploy reads its secrets and redeploy.",
      { missing: readiness.missing },
    );
  }
}

// The single gate the call surface checks before showing the teacher's toggle,
// and that both caption routes re-check on every call. The key AND the flag are
// required — see the module note. Emits the misconfig diagnostic (once)
// whenever it resolves to unavailable, so "flag on, key missing" leaves a trail.
export function liveCaptionsEnabled(): boolean {
  const enabled = enablementFlagOn() && captionsConfigured();
  if (!enabled) warnIfCaptionsMisconfigured();
  return enabled;
}
