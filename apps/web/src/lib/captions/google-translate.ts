import "server-only";
import { baseLanguage } from "@spiralclass/shared";
import { googleTranslateApiKey } from "@/lib/captions/config";

// Google Cloud Translation (v2, "Basic" NMT) — the server half of live-caption
// translation (D-185). Only desktop Chrome translates on the device, so every
// other browser's finished utterances come through POST /api/captions/translate
// to here. Plain fetch to the REST endpoint (no SDK, like google-tts.ts),
// authenticated with an API key restricted to this one API: the app is not
// always served from Google Cloud, so ambient service-account credentials are
// not something to rely on.
//
// Priced per character after a monthly free allowance; the route logs the
// count per call and the operator's Google Cloud budget alert is the
// authoritative warning. Nothing here stores the text.

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

// A caption that arrives after this is no longer live, and a request stuck
// longer holds a server connection for nothing.
const TIMEOUT_MS = 5_000;

export type GoogleTranslateResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not-configured" | "rejected" | "unavailable"; status?: number };

export async function translateWithGoogle(
  text: string,
  source: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTranslateResult> {
  const key = googleTranslateApiKey();
  if (!key) return { ok: false, reason: "not-configured" };

  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        q: text,
        // Bare languages: v2 translates languages, and a regional recognition
        // tag such as "es-MX" is not one of its codes.
        source: baseLanguage(source),
        target: baseLanguage(target),
        // "text", not the default "html": the default escapes apostrophes and
        // ampersands into entities that the caption band would print verbatim.
        format: "text",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // 4xx is our request or our key (bad language code, key restricted to
  // another API, quota); 5xx is Google. The caller maps both to one clean
  // error, but the status is kept for its log line.
  if (!res.ok) {
    return {
      ok: false,
      reason: res.status >= 500 ? "unavailable" : "rejected",
      status: res.status,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    data?: { translations?: { translatedText?: unknown }[] };
  } | null;
  const translated = body?.data?.translations?.[0]?.translatedText;
  if (typeof translated !== "string" || !translated.trim()) {
    return { ok: false, reason: "unavailable", status: res.status };
  }
  return { ok: true, text: translated.trim() };
}
