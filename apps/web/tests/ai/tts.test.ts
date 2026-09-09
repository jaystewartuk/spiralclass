import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The vendor-neutral TTS seam: picks Google when its key is set, else falls back
// to ElevenLabs. Mock both providers + the creds gate and assert routing.

vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({ hasGoogleTtsCreds: vi.fn(() => true) }));
vi.mock("@/lib/env", () => env);

const google = vi.hoisted(() => ({ synthesizeWithGoogle: vi.fn() }));
const eleven = vi.hoisted(() => ({ synthesizePodcast: vi.fn() }));
vi.mock("@/lib/ai/google-tts", () => google);
vi.mock("@/lib/ai/elevenlabs", () => eleven);

import { synthesizePodcast } from "@/lib/ai/tts";

const okResult = {
  ok: true as const,
  audio: new Uint8Array([1]),
  contentType: "audio/mpeg" as const,
  voiceId: "v",
};

describe("synthesizePodcast (rail selector)", () => {
  beforeEach(() => {
    google.synthesizeWithGoogle.mockResolvedValue(okResult);
    eleven.synthesizePodcast.mockResolvedValue(okResult);
  });
  afterEach(() => vi.clearAllMocks());

  it("routes to Google when its key is configured, forwarding language opts", async () => {
    env.hasGoogleTtsCreds.mockReturnValue(true);
    await synthesizePodcast("hello", { language: "Spanish", locale: "es-MX" });
    expect(google.synthesizeWithGoogle).toHaveBeenCalledWith("hello", {
      language: "Spanish",
      locale: "es-MX",
    });
    expect(eleven.synthesizePodcast).not.toHaveBeenCalled();
  });

  it("falls back to ElevenLabs when Google is not configured", async () => {
    env.hasGoogleTtsCreds.mockReturnValue(false);
    await synthesizePodcast("hello", { language: "Spanish", locale: "es-MX" });
    expect(eleven.synthesizePodcast).toHaveBeenCalledWith("hello");
    expect(google.synthesizeWithGoogle).not.toHaveBeenCalled();
  });
});
