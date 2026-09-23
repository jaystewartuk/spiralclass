import "server-only";
import { baseLanguage } from "@spiralclass/shared";
import { deepgramApiKey } from "@/lib/captions/config";

// Deepgram streaming speech-to-text for live captions' phone-to-phone
// fallback (D-185's addendum). When no browser in a class can recognise
// speech, each speaker's own browser streams its microphone straight to
// Deepgram. The long-lived DEEPGRAM_API_KEY never leaves the server: the
// browser is handed a short-lived token from Deepgram's /v1/auth/grant, and
// a listen URL whose model and language this module chose, never the client.
//
// Checked against Deepgram's documentation on 2026-09-23:
//   * A grant token lives 30 s by default (max 3600) and only has to be valid
//     for the WebSocket handshake; the socket then stays open until closed.
//   * Minting one needs a key with the Member role or above; a weaker key is
//     answered 403 "Insufficient permissions".
//   * The token carries usage:write for the core voice APIs, not just /listen,
//     which is one more reason to keep it short-lived.
//   * A browser cannot set an Authorization header on a WebSocket, so it
//     offers the token as the subprotocols ["bearer", <token>] — what
//     Deepgram's own JS SDK (v5.12.0, getWebSocketOptions) does in a browser.

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_LIVE_MODEL = "nova-3";

// Enough for the token request's response to reach the browser and the
// browser to open the socket, with room for a slow phone network. Nothing
// longer is needed: a reconnect asks for a fresh token.
export const GRANT_TTL_SECONDS = 30;

const TIMEOUT_MS = 5_000;

// Nova-3's streaming languages (Deepgram's models-languages overview,
// 2026-09-23). A regional tag is used when Deepgram publishes that exact
// variant; every other Spanish region is Latin American Spanish ("es-419"),
// which is closer to a Mexican or Colombian speaker than Spain's "es"; any
// other tag falls back to its bare language when that is supported.
const REGIONAL = new Set([
  "en-US",
  "en-AU",
  "en-GB",
  "en-IN",
  "en-NZ",
  "fr-CA",
  "de-CH",
  "nl-BE",
  "pt-BR",
  "pt-PT",
  "ar-AE",
  "ar-SA",
  "ar-QA",
  "ar-KW",
  "ar-LB",
  "ar-JO",
  "ar-EG",
  "ar-MA",
  "ar-DZ",
  "ar-TN",
  "ar-IQ",
]);
const LANGUAGES = new Set([
  "af",
  "ar",
  "as",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "it",
  "ja",
  "ka",
  "kk",
  "kn",
  "ko",
  "lt",
  "lv",
  "mk",
  "mn",
  "mr",
  "ms",
  "ne",
  "nl",
  "no",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
]);

// The Deepgram `language` for a speaker's recognition locale (the same
// recognitionLocale a browser recogniser would use), or null when Nova-3
// cannot stream it.
export function deepgramLiveLanguage(locale: string): string | null {
  const [rawLang, rawRegion] = locale.trim().split("-");
  const lang = baseLanguage(rawLang ?? "");
  const region = rawRegion?.toUpperCase();
  if (region) {
    const tag = `${lang}-${region}`;
    if (REGIONAL.has(tag)) return tag;
    if (lang === "es" && region !== "ES") return "es-419";
  }
  return LANGUAGES.has(lang) ? lang : null;
}

// The socket URL the browser opens. Finals only (interim_results=false): a
// caption is translated and shown once per finished phrase, exactly like the
// browser recogniser's output, and partials would be translated work thrown
// away. smart_format adds punctuation and casing a reader expects.
//
// mip_opt_out keeps this audio out of Deepgram's Model Improvement Program:
// without it Deepgram may store part of the request to train its models,
// and with it "data from opted-out requests is retained only for the
// duration necessary to process the request" (Deepgram's documentation,
// 2026-09-23). This is a live lesson's speech, a student's among it, and the
// captions are promised to be stored nowhere.
export function deepgramListenUrl(language: string): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_LIVE_MODEL,
    language,
    smart_format: "true",
    interim_results: "false",
    mip_opt_out: "true",
  });
  return `${LISTEN_URL}?${params.toString()}`;
}

export type DeepgramGrant =
  | { ok: true; token: string; expiresInSeconds: number }
  | { ok: false; reason: "not-configured" | "rejected" | "unavailable"; status?: number };

export async function grantDeepgramToken(fetchImpl: typeof fetch = fetch): Promise<DeepgramGrant> {
  const key = deepgramApiKey();
  if (!key) return { ok: false, reason: "not-configured" };

  let res: Response;
  try {
    res = await fetchImpl(GRANT_URL, {
      method: "POST",
      headers: { authorization: `Token ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: GRANT_TTL_SECONDS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // 4xx is our key (a role below Member is refused 403); 5xx is Deepgram.
  if (!res.ok) {
    return {
      ok: false,
      reason: res.status >= 500 ? "unavailable" : "rejected",
      status: res.status,
    };
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  const token = body?.access_token;
  if (typeof token !== "string" || !token) {
    return { ok: false, reason: "unavailable", status: res.status };
  }
  return {
    ok: true,
    token,
    expiresInSeconds: typeof body?.expires_in === "number" ? body.expires_in : GRANT_TTL_SECONDS,
  };
}
