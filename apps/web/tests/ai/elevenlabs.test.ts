import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ElevenLabs TTS wrapper. Mock the env readers (creds/voice/model) and global
// fetch so we assert the REST shape + graceful degrade without a real key.

// elevenlabs.ts is a server module (`import "server-only"`) — neutralize that guard.
vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({
  hasElevenLabsCreds: vi.fn(() => true),
  elevenLabsApiKey: vi.fn(() => "xi-test-key"),
  elevenLabsVoiceId: vi.fn(() => "voice-123"),
  elevenLabsModelId: vi.fn(() => "eleven_multilingual_v2"),
}));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { synthesizePodcast } from "@/lib/ai/elevenlabs";

function mp3Response(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => "",
  } as unknown as Response;
}

describe("synthesizePodcast", () => {
  beforeEach(() => {
    env.hasElevenLabsCreds.mockReturnValue(true);
    env.elevenLabsApiKey.mockReturnValue("xi-test-key");
    env.elevenLabsVoiceId.mockReturnValue("voice-123");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns not-configured when no key", async () => {
    env.hasElevenLabsCreds.mockReturnValue(false);
    const res = await synthesizePodcast("hello");
    expect(res).toEqual({ ok: false, reason: "not-configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty for a blank script without calling out", async () => {
    const res = await synthesizePodcast("   ");
    expect(res).toEqual({ ok: false, reason: "empty" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to the voice endpoint with the api key + model + returns mp3 bytes", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mp3Response(audio));
    const res = await synthesizePodcast("Welcome to the show.");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.contentType).toBe("audio/mpeg");
      expect(Array.from(res.audio)).toEqual([1, 2, 3, 4]);
      expect(res.voiceId).toBe("voice-123");
    }
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/text-to-speech/voice-123");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.text).toBe("Welcome to the show.");
  });

  it("returns error on a non-2xx response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mp3Response(new Uint8Array(), false, 429),
    );
    expect(await synthesizePodcast("hi")).toEqual({ ok: false, reason: "error" });
  });

  it("returns empty when the vendor returns zero bytes", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mp3Response(new Uint8Array()));
    expect(await synthesizePodcast("hi")).toEqual({ ok: false, reason: "empty" });
  });

  it("returns error when fetch throws", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    expect(await synthesizePodcast("hi")).toEqual({ ok: false, reason: "error" });
  });

  it("bounds the script length sent to the vendor", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mp3Response(new Uint8Array([9])));
    await synthesizePodcast("a".repeat(20_000));
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.text.length).toBeLessThanOrEqual(8_000);
  });
});
