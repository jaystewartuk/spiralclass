import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookingIdFromRoomName, loadConfig } from "./config";

describe("bookingIdFromRoomName", () => {
  it("recovers the booking id from a class room name", () => {
    expect(bookingIdFromRoomName("class-b1")).toBe("b1");
  });

  it("returns null for a room name that isn't one of ours", () => {
    expect(bookingIdFromRoomName("something-else")).toBeNull();
  });
});

describe("loadConfig", () => {
  const REQUIRED = {
    LIVEKIT_URL: "wss://livekit.spiralclass.com",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    DEEPGRAM_API_KEY: "dg-key",
    APP_INTERNAL_BASE_URL: "https://spiralclass.com",
    CAPTIONS_AGENT_SHARED_SECRET: "shared-secret",
    ANTHROPIC_API_KEY: "sk-ant-key",
  };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
    delete process.env.ROOM_POLL_INTERVAL_MS;
    delete process.env.ROOM_CONFIG_POLL_INTERVAL_MS;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CAPTION_TRANSLATION_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads all required vars and applies default poll intervals", () => {
    const config = loadConfig();
    expect(config.livekitUrl).toBe(REQUIRED.LIVEKIT_URL);
    expect(config.deepgramApiKey).toBe(REQUIRED.DEEPGRAM_API_KEY);
    expect(config.anthropicApiKey).toBe(REQUIRED.ANTHROPIC_API_KEY);
    expect(config.roomPollIntervalMs).toBe(3_000);
    expect(config.roomConfigPollIntervalMs).toBe(60_000);
  });

  it("defaults the Anthropic models when unset", () => {
    const config = loadConfig();
    expect(config.anthropicModel).toBe("claude-sonnet-5");
    expect(config.captionTranslationModel).toBe("claude-haiku-4-5");
  });

  it("respects ANTHROPIC_MODEL/CAPTION_TRANSLATION_MODEL overrides", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    process.env.CAPTION_TRANSLATION_MODEL = "claude-haiku-4-5-20251001";
    const config = loadConfig();
    expect(config.anthropicModel).toBe("claude-opus-5");
    expect(config.captionTranslationModel).toBe("claude-haiku-4-5-20251001");
  });

  it("throws when a required var is missing", () => {
    delete process.env.DEEPGRAM_API_KEY;
    expect(() => loadConfig()).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when a required var is blank", () => {
    process.env.LIVEKIT_API_SECRET = "   ";
    expect(() => loadConfig()).toThrow(/LIVEKIT_API_SECRET/);
  });
});
