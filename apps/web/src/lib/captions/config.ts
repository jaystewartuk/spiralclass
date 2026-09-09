import { logger } from "@/lib/logger";

// Live in-class captions config + availability gate (D-27).
//
// The teacher speaks Spanish; the student sees English subtitles in real time.
// Unlike the post-class transcription pipeline (lib/transcription, D-19), this is
// a LIVE path that runs entirely while the call is up: the teacher's browser
// streams its own mic to Deepgram's streaming ASR, each finished Spanish
// utterance is translated to English on our server (the platform Anthropic key),
// and the English line is published into the LiveKit room for the other side to
// render. Nothing is stored — captions are ephemeral and never persisted.
//
// Two independent conditions must BOTH hold before the feature is offered:
//   1. Both vendors are configured: a Deepgram key (streaming ASR) AND Anthropic
//      creds (translation). Either missing → the teacher's toggle is hidden and
//      the call behaves exactly as before.
//   2. The explicit enablement flag (LIVE_CAPTIONS_ENABLED) is on. Like the
//      transcription flag, this exists because sending a live lesson's audio to
//      an outside ASR vendor carries the same privacy/consent weight (D-21/D-22)
//      — the code can ship and keys can be set while the switch stays off.
//
// Keys are read straight from process.env (like provider.ts / transcription
// config) so an availability check never depends on the whole env schema
// validating — a page can ask "are captions available?" without every unrelated
// var being present.

const log = logger({ surface: "captions" });

// Trim + strip one layer of accidentally-wrapped quotes (a copy-paste mistake
// from a .env-style snippet — pasting `KEY="abc"` verbatim into an env-var UI
// field). Shared by every vendor-key reader in this module so the fix lives in
// one place; each key still fails a DIFFERENT way when malformed — Deepgram
// rejects it outright (400) while Anthropic's SDK returns an auth error that
// this module's callers otherwise can't distinguish from "not configured".
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
// DEEPGRAM_API_KEY (this module, transcription/config.ts) goes through here so
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

// Both vendors present? Captions need Deepgram (ASR) AND Anthropic
// (translation). Read straight from process.env (not env.ts's serverEnv(),
// see the module note above on why) and through the same sanitizer as
// deepgramApiKey — an unquoted-vs-quoted ANTHROPIC_API_KEY was the other half
// of the same copy-paste mistake, and it surfaced as translate calls failing
// with an opaque 502 rather than "not configured".
export function captionsConfigured(): boolean {
  return Boolean(deepgramApiKey() && sanitizeApiKey(process.env.ANTHROPIC_API_KEY));
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
// flag is on but a vendor key is absent, liveCaptionsEnabled() returns false,
// the teacher's toggle is hidden, and both /api/captions/{token,translate}
// (plus their four mobile siblings) return 404 with no logged reason. That is
// exactly the shape of the Vercel→Fly cutover (D-70) regression: DEEPGRAM_API_KEY
// was configured on Vercel but not carried into Fly's `fly secrets`, so captions
// went dark on preview with nothing in the logs to point at the missing key.
export type CaptionsReadiness = {
  flagOn: boolean;
  deepgram: boolean;
  anthropic: boolean;
  enabled: boolean;
  missing: string[];
};

export function captionsReadiness(): CaptionsReadiness {
  const flagOn = enablementFlagOn();
  const deepgram = Boolean(deepgramApiKey());
  const anthropic = Boolean(sanitizeApiKey(process.env.ANTHROPIC_API_KEY));
  const missing = [
    deepgram ? null : "DEEPGRAM_API_KEY",
    anthropic ? null : "ANTHROPIC_API_KEY",
  ].filter((v): v is string => v !== null);
  return { flagOn, deepgram, anthropic, enabled: flagOn && deepgram && anthropic, missing };
}

// One structured warning per process when the operator has switched captions ON
// but a required vendor key is missing, so a dark feature is diagnosable from the
// logs instead of silent. Once-guarded (not per-request) so it reads as a boot
// signal on a persistent server (Fly) rather than log spam. No-op when captions
// are correctly configured, or correctly off.
let warnedMisconfig = false;
export function warnIfCaptionsMisconfigured(): void {
  if (warnedMisconfig) return;
  const readiness = captionsReadiness();
  if (readiness.flagOn && !readiness.enabled) {
    warnedMisconfig = true;
    log.warn(
      "LIVE_CAPTIONS_ENABLED is on but required vendor key(s) are missing — captions stay dark (teacher toggle hidden, token/translate routes 404). Classic cause: a key set on Vercel but not carried into Fly `fly secrets` at the Vercel-to-Fly cutover. Set the missing key(s) and redeploy.",
      { missing: readiness.missing },
    );
  }
}

// The single gate the call surface checks before showing the teacher's toggle.
// Both the vendors AND the flag are required — see the module note on the flag.
// Emits the misconfig diagnostic (once) whenever it resolves to unavailable, so
// the "flag on, key missing" state that broke captions at the Fly cutover leaves
// a trail — this is the one chokepoint every web AND mobile caption route hits.
export function liveCaptionsEnabled(): boolean {
  const enabled = enablementFlagOn() && captionsConfigured();
  if (!enabled) warnIfCaptionsMisconfigured();
  return enabled;
}
