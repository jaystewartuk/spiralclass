import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captionsConfigured, deepgramApiKey, liveCaptionsEnabled } from "@/lib/captions/config";

// `warnIfCaptionsMisconfigured` is once-guarded per module instance, so the
// diagnostics suite re-imports the module fresh per test (resetModules) to get a
// clean guard, and spies on the shared logger. `warn` is hoisted so it can be
// referenced inside the hoisted vi.mock factory.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The two-condition availability gate: both vendor keys present AND the explicit
// enablement flag on. Mirrors the transcription gate — keys can be set while the
// switch stays off (privacy/consent), so the feature must stay dormant until both.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deepgramApiKey", () => {
  it("returns undefined when unset or blank", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(deepgramApiKey()).toBeUndefined();
  });

  it("returns the key as-is when it isn't wrapped in quotes", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-real-key-123");
    expect(deepgramApiKey()).toBe("dg-real-key-123");
  });

  it("strips one layer of surrounding double quotes — a copy-paste mistake from a .env-style snippet that makes Deepgram see a malformed token (400) even though the underlying key is fine", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", '"dg-real-key-123"');
    expect(deepgramApiKey()).toBe("dg-real-key-123");
  });

  it("strips one layer of surrounding single quotes", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "'dg-real-key-123'");
    expect(deepgramApiKey()).toBe("dg-real-key-123");
  });

  it("trims surrounding whitespace before and after unwrapping quotes", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", '  "dg-real-key-123"  ');
    expect(deepgramApiKey()).toBe("dg-real-key-123");
  });

  it("leaves a lone quote character alone rather than mangling it", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", '"');
    expect(deepgramApiKey()).toBe('"');
  });

  it("does not strip mismatched quote characters (only a genuine matching wrap)", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "\"dg-real-key-123'");
    expect(deepgramApiKey()).toBe("\"dg-real-key-123'");
  });
});

describe("captionsConfigured", () => {
  it("needs both Deepgram and Anthropic keys", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(captionsConfigured()).toBe(false);

    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    expect(captionsConfigured()).toBe(false);

    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    expect(captionsConfigured()).toBe(true);
  });

  it("still passes when ANTHROPIC_API_KEY is quote-wrapped — the other half of the copy-paste mistake fixed for DEEPGRAM_API_KEY, which made every /api/captions/translate call fail with a 502 even though captionsConfigured() (and liveCaptionsEnabled()) reported the feature as available", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", '"an"');
    expect(captionsConfigured()).toBe(true);
  });
});

describe("liveCaptionsEnabled", () => {
  it("stays off until the flag is on AND both vendors are configured", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");

    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    expect(liveCaptionsEnabled()).toBe(false);

    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    expect(liveCaptionsEnabled()).toBe(true);

    // Flag on but a vendor missing → still off.
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(liveCaptionsEnabled()).toBe(false);
  });

  it("accepts the documented truthy flag spellings", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    for (const v of ["1", "true", "on", "TRUE", "On"]) {
      vi.stubEnv("LIVE_CAPTIONS_ENABLED", v);
      expect(liveCaptionsEnabled()).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      vi.stubEnv("LIVE_CAPTIONS_ENABLED", v);
      expect(liveCaptionsEnabled()).toBe(false);
    }
  });
});

// Diagnostics for the exact Vercel→Fly cutover failure: the flag survives the
// migration (it lives in fly.toml [env]) but a vendor secret doesn't reach
// `fly secrets`, so the feature is dark with no logged reason. captionsReadiness
// reports per-dependency state (booleans only, never the key values) and
// warnIfCaptionsMisconfigured emits one operator warning naming the missing var.
describe("captionsReadiness", () => {
  it("reports every dependency satisfied when the flag is on and both keys are present", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    const { captionsReadiness } = await import("@/lib/captions/config");
    expect(captionsReadiness()).toEqual({
      flagOn: true,
      deepgram: true,
      anthropic: true,
      enabled: true,
      missing: [],
    });
  });

  it("names DEEPGRAM_API_KEY as missing — the key that didn't cross the Fly cutover — while the flag and Anthropic are present", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    const { captionsReadiness } = await import("@/lib/captions/config");
    const r = captionsReadiness();
    expect(r.enabled).toBe(false);
    expect(r.deepgram).toBe(false);
    expect(r.missing).toEqual(["DEEPGRAM_API_KEY"]);
  });

  it("lists both vendor keys when neither is set", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { captionsReadiness } = await import("@/lib/captions/config");
    expect(captionsReadiness().missing).toEqual(["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"]);
  });
});

describe("warnIfCaptionsMisconfigured", () => {
  beforeEach(() => {
    warn.mockClear();
    vi.resetModules();
  });

  it("warns once, naming the missing key, when the flag is on but a vendor key is absent", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");

    warnIfCaptionsMisconfigured();
    warnIfCaptionsMisconfigured();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ missing: ["DEEPGRAM_API_KEY"] });
  });

  it("stays silent when captions are correctly configured", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");
    warnIfCaptionsMisconfigured();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when the feature is deliberately off (flag unset) — a missing key is not a misconfig if nobody asked for captions", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");
    warnIfCaptionsMisconfigured();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is triggered as a side effect of liveCaptionsEnabled() resolving to unavailable — the shared web+mobile chokepoint", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "an");
    const { liveCaptionsEnabled } = await import("@/lib/captions/config");
    expect(liveCaptionsEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ missing: ["DEEPGRAM_API_KEY"] });
  });
});
