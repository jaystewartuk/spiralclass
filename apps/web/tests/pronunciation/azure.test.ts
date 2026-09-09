import { describe, expect, it, vi } from "vitest";
import { mapAzureResponse, scoreWithAzure } from "@/lib/pronunciation/azure";

// Azure pronunciation-assessment response → vendor-agnostic scores. The mapping
// is pure; this pins it against a recorded-shape fixture (ticks → ms, phonemes,
// overall) since real Azure can't run in the dev sandbox.

const FIXTURE = {
  RecognitionStatus: "Success",
  NBest: [
    {
      PronunciationAssessment: {
        AccuracyScore: 85,
        FluencyScore: 78,
        CompletenessScore: 90,
        PronScore: 82,
      },
      Words: [
        {
          Word: "hola",
          Offset: 5_000_000, // 500ms in 100-ns ticks
          Duration: 3_000_000, // 300ms
          PronunciationAssessment: { AccuracyScore: 95 },
          Phonemes: [{ Phoneme: "o", PronunciationAssessment: { AccuracyScore: 95 } }],
        },
        {
          Word: "subjuntivo",
          Offset: 10_000_000, // 1000ms
          Duration: 5_000_000, // 500ms
          PronunciationAssessment: { AccuracyScore: 40 },
          Phonemes: [{ Phoneme: "x", PronunciationAssessment: { AccuracyScore: 30 } }],
        },
      ],
    },
  ],
};

describe("mapAzureResponse", () => {
  it("maps overall + words, converting ticks to ms", () => {
    const result = mapAzureResponse(FIXTURE);
    expect(result.provider).toBe("azure");
    expect(result.overall).toEqual({ accuracy: 85, fluency: 78, completeness: 90, pron: 82 });
    expect(result.words[0]).toEqual({
      word: "hola",
      accuracy: 95,
      startMs: 500,
      endMs: 800,
      phonemes: [{ phoneme: "o", accuracy: 95 }],
    });
    expect(result.words[1]).toMatchObject({
      word: "subjuntivo",
      accuracy: 40,
      startMs: 1000,
      endMs: 1500,
    });
  });

  it("degrades to zero/empty on a malformed payload", () => {
    expect(mapAzureResponse({}).words).toEqual([]);
    expect(mapAzureResponse(null).overall.pron).toBe(0);
  });
});

describe("scoreWithAzure", () => {
  it("fetches the audio then POSTs to Azure with the reference text in the header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => FIXTURE } as Response);

    const result = await scoreWithAzure(
      { key: "az-key", region: "eastus" },
      {
        audioUrl: "https://r2.example/student.ogg",
        referenceText: "hola subjuntivo",
        language: "es",
      },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.words).toHaveLength(2);
    // First call pulls the audio.
    expect(fetchImpl.mock.calls[0][0]).toBe("https://r2.example/student.ogg");
    // Second call is the Azure STT endpoint with the locale + key + base64 config.
    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toContain("eastus.stt.speech.microsoft.com");
    expect(String(url)).toContain("language=es-ES");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("az-key");
    const config = JSON.parse(
      Buffer.from(headers["Pronunciation-Assessment"], "base64").toString(),
    );
    expect(config.ReferenceText).toBe("hola subjuntivo");
    expect(config.Granularity).toBe("Phoneme");
  });

  it("throws on a non-OK Azure response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(
      scoreWithAzure(
        { key: "k", region: "eastus" },
        { audioUrl: "u", referenceText: "x", language: "es" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("azure-pron-http-401");
  });
});
