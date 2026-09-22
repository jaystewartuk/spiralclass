import type { TranscriptionResult, Utterance, Word } from "./types";

// Deepgram pre-recorded ASR adapter (lesson-insights Phase B). One known speaker
// per file, so we do NOT use diarization — we ask for utterance segmentation and
// word timings only. The response→utterances mapping is pure and exported for
// unit testing against a recorded fixture; the network call is a thin wrapper.
//
// Deepgram reports times in SECONDS (float); we convert to integer milliseconds
// relative to the file start (the merge layer offsets onto the booking timeline).

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

// Shape of the bits of Deepgram's JSON we read. Everything optional/loose so a
// malformed payload degrades to an empty transcript rather than throwing.
type DeepgramWord = {
  word?: unknown;
  punctuated_word?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
};
type DeepgramUtterance = {
  transcript?: unknown;
  start?: unknown;
  end?: unknown;
  words?: unknown;
};
type DeepgramResponse = {
  results?: { utterances?: unknown };
};

const sToMs = (s: unknown): number => (typeof s === "number" ? Math.round(s * 1000) : 0);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function mapWord(raw: DeepgramWord): Word {
  return {
    // Prefer the punctuated form for readable text; fall back to the raw token.
    text: str(raw.punctuated_word) || str(raw.word),
    startMs: sToMs(raw.start),
    endMs: sToMs(raw.end),
    confidence: num(raw.confidence, 1),
  };
}

// Pure: Deepgram JSON → vendor-agnostic utterances (file-relative ms).
export function mapDeepgramResponse(json: unknown): TranscriptionResult {
  const response = (json ?? {}) as DeepgramResponse;
  const rawUtterances = response.results?.utterances;
  const list = Array.isArray(rawUtterances) ? (rawUtterances as DeepgramUtterance[]) : [];

  const utterances: Utterance[] = list.map((u) => {
    const words = Array.isArray(u.words) ? (u.words as DeepgramWord[]).map(mapWord) : [];
    return {
      text: str(u.transcript),
      startMs: sToMs(u.start),
      endMs: sToMs(u.end),
      words,
    };
  });

  return { utterances, provider: "deepgram" };
}

export type DeepgramFetch = typeof fetch;

// Thin network wrapper. `fetch` is injectable so the call is testable without a
// real key. Deepgram pulls the audio from `audioUrl` itself (a short-lived R2
// presigned URL), so no bytes pass through our server.
export async function transcribeWithDeepgram(
  apiKey: string,
  input: { audioUrl: string; language: string },
  fetchImpl: DeepgramFetch = fetch,
): Promise<TranscriptionResult> {
  const url = new URL(DEEPGRAM_URL);
  url.searchParams.set("model", "nova-2");
  url.searchParams.set("language", input.language);
  url.searchParams.set("utterances", "true");
  url.searchParams.set("punctuate", "true");

  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: input.audioUrl }),
  });
  if (!res.ok) {
    throw new Error(`deepgram-http-${res.status}`);
  }
  return mapDeepgramResponse(await res.json());
}
