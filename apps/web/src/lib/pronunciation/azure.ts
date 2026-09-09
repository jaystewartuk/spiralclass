import type { PronunciationConfig } from "./config";
import { toAzureLocale } from "./config";
import type { PronunciationResult, ScoredPhoneme, ScoredWord } from "./types";

// Azure AI Speech "Pronunciation Assessment" adapter (lesson-insights Phase D).
// Uses the just-produced student transcript as the reference text (continuous /
// unscripted scoring of spontaneous speech) and returns phoneme-level scores.
// The response→scores mapping is pure and unit-tested against a recorded
// fixture; the network call is a thin wrapper (the audio bytes are pulled from
// the same R2 presigned URL Phase B minted for ASR).
//
// Azure reports time in 100-nanosecond TICKS; we convert to integer ms.

const STT_PATH = "/speech/recognition/conversation/cognitiveservices/v1";

const ticksToMs = (ticks: unknown): number =>
  typeof ticks === "number" ? Math.round(ticks / 10_000) : 0;
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Loose shapes — anything missing degrades to zero/empty rather than throwing.
type AzurePA = {
  AccuracyScore?: unknown;
  FluencyScore?: unknown;
  CompletenessScore?: unknown;
  PronScore?: unknown;
};
type AzurePhoneme = { Phoneme?: unknown; PronunciationAssessment?: { AccuracyScore?: unknown } };
type AzureWord = {
  Word?: unknown;
  Offset?: unknown;
  Duration?: unknown;
  PronunciationAssessment?: { AccuracyScore?: unknown };
  Phonemes?: unknown;
};
type AzureResponse = {
  NBest?: Array<{ PronunciationAssessment?: AzurePA; Words?: unknown }>;
};

function mapPhoneme(p: AzurePhoneme): ScoredPhoneme {
  return { phoneme: str(p.Phoneme), accuracy: num(p.PronunciationAssessment?.AccuracyScore) };
}

function mapWord(w: AzureWord): ScoredWord {
  const offset = w.Offset;
  const duration = w.Duration;
  const phonemes = Array.isArray(w.Phonemes) ? (w.Phonemes as AzurePhoneme[]).map(mapPhoneme) : [];
  return {
    word: str(w.Word),
    accuracy: num(w.PronunciationAssessment?.AccuracyScore),
    startMs: ticksToMs(offset),
    endMs: ticksToMs(num(offset) + num(duration)),
    ...(phonemes.length ? { phonemes } : {}),
  };
}

// Pure: Azure detailed JSON → vendor-agnostic result.
export function mapAzureResponse(json: unknown): PronunciationResult {
  const best = (json as AzureResponse)?.NBest?.[0];
  const pa = best?.PronunciationAssessment ?? {};
  const words = Array.isArray(best?.Words) ? (best!.Words as AzureWord[]).map(mapWord) : [];
  return {
    overall: {
      accuracy: num(pa.AccuracyScore),
      fluency: num(pa.FluencyScore),
      completeness: num(pa.CompletenessScore),
      pron: num(pa.PronScore),
    },
    words,
    provider: "azure",
  };
}

export type AzureFetch = typeof fetch;

// Score one student audio file. Pulls the audio bytes from `audioUrl` (the R2
// presigned URL) and POSTs them to Azure with the reference text in the
// Pronunciation-Assessment header. `fetch` is injectable for testing.
export async function scoreWithAzure(
  cfg: PronunciationConfig,
  input: { audioUrl: string; referenceText: string; language: string },
  fetchImpl: AzureFetch = fetch,
): Promise<PronunciationResult> {
  const locale = toAzureLocale(input.language);
  const url = `https://${cfg.region}.stt.speech.microsoft.com${STT_PATH}?language=${encodeURIComponent(locale)}&format=detailed`;

  const assessmentParams = Buffer.from(
    JSON.stringify({
      ReferenceText: input.referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
    }),
  ).toString("base64");

  const audioRes = await fetchImpl(input.audioUrl);
  if (!audioRes.ok) throw new Error(`azure-audio-fetch-${audioRes.status}`);
  const audio = await audioRes.arrayBuffer();

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": cfg.key,
      // Phase A captures OGG/Opus.
      "Content-Type": "audio/ogg; codecs=opus",
      Accept: "application/json",
      "Pronunciation-Assessment": assessmentParams,
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`azure-pron-http-${res.status}`);
  return mapAzureResponse(await res.json());
}
