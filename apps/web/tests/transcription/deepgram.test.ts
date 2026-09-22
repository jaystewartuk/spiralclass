import { describe, expect, it, vi } from "vitest";
import { mapDeepgramResponse, transcribeWithDeepgram } from "@/lib/transcription/deepgram";

// Deepgram response → vendor-agnostic utterances. The mapping is pure; this pins
// it against a recorded-shape fixture (seconds → ms, punctuated word preference,
// graceful degradation on malformed payloads).

const FIXTURE = {
  results: {
    utterances: [
      {
        transcript: "Hola, ¿cómo estás?",
        start: 0.5,
        end: 2.0,
        confidence: 0.98,
        words: [
          { word: "hola", punctuated_word: "Hola,", start: 0.5, end: 1.0, confidence: 0.99 },
          { word: "como", punctuated_word: "cómo", start: 1.2, end: 1.5, confidence: 0.95 },
          { word: "estas", punctuated_word: "estás?", start: 1.6, end: 2.0, confidence: 0.97 },
        ],
      },
      { transcript: "Bien.", start: 3.0, end: 3.4, confidence: 0.9, words: [] },
    ],
  },
};

describe("mapDeepgramResponse", () => {
  it("maps utterances + words, converting seconds to integer ms", () => {
    const result = mapDeepgramResponse(FIXTURE);
    expect(result.provider).toBe("deepgram");
    expect(result.utterances).toHaveLength(2);

    const first = result.utterances[0];
    expect(first).toMatchObject({ text: "Hola, ¿cómo estás?", startMs: 500, endMs: 2000 });
    expect(first.words[0]).toEqual({ text: "Hola,", startMs: 500, endMs: 1000, confidence: 0.99 });
    // Prefers punctuated_word; falls through to `word` only when absent.
    expect(first.words[1].text).toBe("cómo");
  });

  it("degrades to an empty transcript on a malformed payload", () => {
    expect(mapDeepgramResponse({}).utterances).toEqual([]);
    expect(mapDeepgramResponse(null).utterances).toEqual([]);
    expect(mapDeepgramResponse({ results: { utterances: "nope" } }).utterances).toEqual([]);
  });
});

describe("transcribeWithDeepgram", () => {
  it("POSTs the audio URL with the language + auth, and maps the response", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        ({ ok: true, json: async () => FIXTURE }) as Response,
    );

    const result = await transcribeWithDeepgram(
      "dg-key",
      { audioUrl: "https://r2.example/audio.ogg", language: "es" },
      fetchImpl,
    );

    expect(result.utterances).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0];
    const headers = (init!.headers ?? {}) as Record<string, string>;
    expect(String(url)).toContain("language=es");
    expect(String(url)).toContain("utterances=true");
    expect(init!.method).toBe("POST");
    expect(headers.Authorization).toBe("Token dg-key");
    expect(JSON.parse(String(init!.body))).toEqual({ url: "https://r2.example/audio.ogg" });
  });

  it("throws on a non-OK vendor response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
    await expect(
      transcribeWithDeepgram("k", { audioUrl: "u", language: "es" }, fetchImpl),
    ).rejects.toThrow("deepgram-http-429");
  });
});
