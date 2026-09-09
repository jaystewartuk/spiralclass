import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Google Cloud TTS wrapper. Mock the env readers + global fetch so we assert the
// REST shape (endpoint, api-key header, voice/languageCode), the base64→bytes
// decode, sentence chunking under the byte ceiling, and graceful degrade — all
// without a real key or network.

vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({
  hasGoogleTtsCreds: vi.fn(() => true),
  googleTtsApiKey: vi.fn(() => "g-test-key"),
  googleTtsVoice: vi.fn((): string | undefined => undefined),
  googleTtsLanguageCode: vi.fn((): string | undefined => undefined),
}));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { chunkForTts, synthesizeWithGoogle } from "@/lib/ai/google-tts";

function ttsResponse(bytes: number[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ audioContent: Buffer.from(bytes).toString("base64") }),
    text: async () => "error body",
  } as unknown as Response;
}

describe("chunkForTts", () => {
  it("keeps a short script in a single chunk", () => {
    expect(chunkForTts("Hello world. Nice to meet you.", 4500)).toEqual([
      "Hello world. Nice to meet you.",
    ]);
  });

  it("splits on sentence boundaries when the budget is exceeded", () => {
    const chunks = chunkForTts("aaaa. bbbb. cccc.", 6);
    // Each ~"aaaa." unit is ≤6 bytes; packing stays under budget per chunk.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(6);
    // No content lost (ignoring the whitespace we trim between chunks).
    expect(chunks.join("").replace(/\s/g, "")).toBe("aaaa.bbbb.cccc.");
  });

  it("never splits a multi-byte character mid-codepoint", () => {
    // 'é' is 2 bytes in UTF-8; a tiny budget must still cut on char boundaries.
    const chunks = chunkForTts("ééééééééé", 3);
    for (const c of chunks) {
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(3);
      expect(c).not.toContain("�"); // no replacement char from a bad slice
    }
    expect(chunks.join("")).toBe("ééééééééé");
  });
});

describe("synthesizeWithGoogle", () => {
  beforeEach(() => {
    env.hasGoogleTtsCreds.mockReturnValue(true);
    env.googleTtsApiKey.mockReturnValue("g-test-key");
    env.googleTtsVoice.mockReturnValue(undefined);
    env.googleTtsLanguageCode.mockReturnValue(undefined);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns not-configured when no key", async () => {
    env.hasGoogleTtsCreds.mockReturnValue(false);
    expect(await synthesizeWithGoogle("hello")).toEqual({ ok: false, reason: "not-configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty for a blank script without calling out", async () => {
    expect(await synthesizeWithGoogle("   ")).toEqual({ ok: false, reason: "empty" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to text:synthesize with the api-key header and decodes base64 mp3", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ttsResponse([1, 2, 3, 4]));
    const res = await synthesizeWithGoogle("Welcome to the show.");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.contentType).toBe("audio/mpeg");
      expect(Array.from(res.audio)).toEqual([1, 2, 3, 4]);
      expect(res.voiceId).toBe("es-US-Neural2-A"); // default (Spanish) voice
    }
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("texttospeech.googleapis.com/v1/text:synthesize");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.input.text).toBe("Welcome to the show.");
    expect(body.voice).toEqual({ languageCode: "es-US", name: "es-US-Neural2-A" });
    expect(body.audioConfig.audioEncoding).toBe("MP3");
  });

  it("maps the en locale to an English voice", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ttsResponse([9]));
    await synthesizeWithGoogle("Hi there.", { locale: "en" });
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.voice).toEqual({ languageCode: "en-US", name: "en-US-Neural2-C" });
  });

  it("honors explicit voice + languageCode env overrides", async () => {
    env.googleTtsVoice.mockReturnValue("es-MX-Custom");
    env.googleTtsLanguageCode.mockReturnValue("es-ES");
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ttsResponse([9]));
    await synthesizeWithGoogle("Hola.");
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.voice).toEqual({ languageCode: "es-ES", name: "es-MX-Custom" });
  });

  it("chunks a long script into multiple requests and concatenates the mp3s", async () => {
    let call = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ttsResponse([++call]));
    // ~8k ASCII bytes (the char cap) over a 4500-byte request budget → 2 chunks.
    const res = await synthesizeWithGoogle("Hola mundo, esto es una prueba. ".repeat(300));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.audio)).toEqual([1, 2]); // concatenated in order
  });

  it("returns error on a non-2xx response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ttsResponse([], false, 401));
    expect(await synthesizeWithGoogle("hi")).toEqual({ ok: false, reason: "error" });
  });

  it("returns empty when the vendor omits audioContent", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response);
    expect(await synthesizeWithGoogle("hi")).toEqual({ ok: false, reason: "empty" });
  });

  it("returns error when fetch throws", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    expect(await synthesizeWithGoogle("hi")).toEqual({ ok: false, reason: "error" });
  });
});
