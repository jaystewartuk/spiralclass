import "server-only";
import {
  googleTtsApiKey,
  googleTtsLanguageCode,
  googleTtsVoice,
  hasGoogleTtsCreds,
} from "@/lib/env";
import { logger } from "@/lib/logger";
import { PODCAST_SCRIPT_MAX_CHARS } from "@/lib/materials/config";
import type { SynthesizeOpts, SynthesizePodcastResult } from "./tts";
import { usesEnglishCopy } from "@spiralclass/shared";

const log = logger({ surface: "ai" });

// Google Cloud Text-to-Speech — the preferred podcast rail. Plain fetch to the
// REST endpoint (no SDK, like the rest of the repo), API-key auth via the
// X-Goog-Api-Key header, MP3 out. Routed through the PLATFORM key only.
//
// Two things differ from ElevenLabs and shape this file:
//  1. text:synthesize rejects input over 5000 BYTES per request, while a podcast
//     script can run to PODCAST_SCRIPT_MAX_CHARS (8k) — and Spanish accents are
//     2 bytes each. So we chunk on sentence (then word) boundaries under a byte
//     budget and concatenate the returned MP3s. Separately-synthesized MP3 frame
//     streams play back as one continuous clip; the seams are inaudible in speech.
//  2. Google needs an explicit languageCode + voice, where ElevenLabs' one
//     multilingual model auto-detects. We map the narration language to a Neural2
//     voice (env-overridable), defaulting by locale.

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

// Comfortably under Google's 5000-byte input ceiling so multi-byte scripts never
// trip it, with headroom for the request never being exactly at the boundary.
const MAX_REQUEST_BYTES = 4500;

// Narration language (display name, lowercased) → BCP-47 code + a Neural2 voice.
// Neural2 is the cheap "neural quality" tier; these are all real, widely
// available voices. Covers the languages a teacher is realistically narrating
// in; anything else falls back to the locale default below.
const LANGUAGE_VOICES: Record<string, { languageCode: string; voice: string }> = {
  spanish: { languageCode: "es-US", voice: "es-US-Neural2-A" },
  english: { languageCode: "en-US", voice: "en-US-Neural2-C" },
  french: { languageCode: "fr-FR", voice: "fr-FR-Neural2-A" },
  portuguese: { languageCode: "pt-BR", voice: "pt-BR-Neural2-A" },
  german: { languageCode: "de-DE", voice: "de-DE-Neural2-A" },
  italian: { languageCode: "it-IT", voice: "it-IT-Neural2-A" },
};

// Resolve the languageCode + voice for this synthesis. Explicit env overrides
// win; otherwise map the narration language (or the locale default) to a voice.
// Mirrors buildPodcastScriptPrompt's own output-language default (locale → es/en).
function resolveVoice(opts?: SynthesizeOpts): { languageCode: string; voice: string } {
  const name = (
    opts?.language?.trim() || (usesEnglishCopy(opts?.locale) ? "English" : "Spanish")
  ).toLowerCase();
  const localeDefault = usesEnglishCopy(opts?.locale)
    ? LANGUAGE_VOICES.english
    : LANGUAGE_VOICES.spanish;
  const base = LANGUAGE_VOICES[name] ?? localeDefault;
  return {
    languageCode: googleTtsLanguageCode() ?? base.languageCode,
    voice: googleTtsVoice() ?? base.voice,
  };
}

const encoder = new TextEncoder();
const byteLen = (s: string): number => encoder.encode(s).length;

// Greedily pack `text` into chunks each ≤ maxBytes, breaking at sentence then
// word boundaries so a chunk never splits mid-word (which would mangle the
// spoken audio). A pathological single token longer than the budget is sliced
// by code point as a last resort (never mid-character). Exported for tests.
export function chunkForTts(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  // Sentence-ish units keep their trailing punctuation and whitespace.
  const sentences = text.match(/\s*[^.!?\n]+[.!?\n]*/g) ?? [text];
  for (const sentence of sentences) {
    if (byteLen(sentence) <= maxBytes) {
      if (cur && byteLen(cur + sentence) > maxBytes) flush();
      cur += sentence;
      continue;
    }
    // Sentence too long on its own: flush, then pack it word by word.
    flush();
    for (const word of sentence.split(/(\s+)/)) {
      if (byteLen(word) > maxBytes) {
        flush();
        for (const seg of sliceByBytes(word, maxBytes)) out.push(seg);
        continue;
      }
      if (cur && byteLen(cur + word) > maxBytes) flush();
      cur += word;
    }
  }
  flush();
  return out;
}

function sliceByBytes(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (cur && byteLen(cur + ch) > maxBytes) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function synthesizeWithGoogle(
  text: string,
  opts?: SynthesizeOpts,
): Promise<SynthesizePodcastResult> {
  if (!hasGoogleTtsCreds()) return { ok: false, reason: "not-configured" };

  const body = text.trim().slice(0, PODCAST_SCRIPT_MAX_CHARS);
  if (!body) return { ok: false, reason: "empty" };

  const { languageCode, voice } = resolveVoice(opts);
  const chunks = chunkForTts(body, MAX_REQUEST_BYTES);
  const parts: Uint8Array[] = [];

  try {
    for (const chunk of chunks) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": googleTtsApiKey() as string,
        },
        body: JSON.stringify({
          input: { text: chunk },
          voice: { languageCode, name: voice },
          audioConfig: { audioEncoding: "MP3", sampleRateHertz: 44100 },
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        log.error("google tts synth failed", { status: res.status, body: detail.slice(0, 200) });
        return { ok: false, reason: "error" };
      }

      const json = (await res.json()) as { audioContent?: string };
      if (!json.audioContent) return { ok: false, reason: "empty" };
      parts.push(new Uint8Array(Buffer.from(json.audioContent, "base64")));
    }
  } catch (err) {
    log.error("google tts synth threw", err);
    return { ok: false, reason: "error" };
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  if (total === 0) return { ok: false, reason: "empty" };

  const audio = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    audio.set(p, offset);
    offset += p.byteLength;
  }
  return { ok: true, audio, contentType: "audio/mpeg", voiceId: voice };
}
