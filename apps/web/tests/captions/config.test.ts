import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captionsConfigured,
  deepgramApiKey,
  googleTranslateApiKey,
  liveCaptionsEnabled,
} from "@/lib/captions/config";

// `warnIfCaptionsMisconfigured` is once-guarded per module instance, so the
// diagnostics suite re-imports the module fresh per test (resetModules) to get a
// clean guard, and spies on the shared logger. `warn` is hoisted so it can be
// referenced inside the hoisted vi.mock factory.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The two-condition availability gate: the translation fallback's key present
// AND the explicit enablement flag on (D-185). Mirrors the transcription gate —
// the key can be set while the switch stays off (privacy/consent), so the
// feature must stay dormant until both.

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

describe("googleTranslateApiKey", () => {
  it("returns undefined when unset or blank", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", " ");
    expect(googleTranslateApiKey()).toBeUndefined();
  });

  it("unwraps a quote-wrapped key, like every key this module reads", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", '"AIza-key"');
    expect(googleTranslateApiKey()).toBe("AIza-key");
  });
});

describe("captionsConfigured", () => {
  it("needs the Google Cloud Translation key", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    expect(captionsConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    expect(captionsConfigured()).toBe(true);
  });

  // The retired design needed both; captions no longer call either vendor, and
  // requiring them would keep a working feature dark on a deploy without them.
  it("no longer needs Deepgram or Anthropic", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(captionsConfigured()).toBe(true);
  });
});

describe("liveCaptionsEnabled", () => {
  it("stays off until the flag is on AND the key is configured", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");

    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    expect(liveCaptionsEnabled()).toBe(false);

    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    expect(liveCaptionsEnabled()).toBe(true);

    // Flag on but the key missing → still off.
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    expect(liveCaptionsEnabled()).toBe(false);
  });

  it("accepts the documented truthy flag spellings", () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
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

// Diagnostics for the failure shape the Vercel→Fly cutover produced: the flag
// reaches the new deploy but a secret doesn't, so the feature is dark with no
// logged reason. captionsReadiness reports per-dependency state (booleans only,
// never the key value) and warnIfCaptionsMisconfigured emits one operator
// warning naming the missing var.
describe("captionsReadiness", () => {
  it("reports every dependency satisfied when the flag is on and the key is present", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const { captionsReadiness } = await import("@/lib/captions/config");
    expect(captionsReadiness()).toEqual({
      flagOn: true,
      googleTranslate: true,
      enabled: true,
      missing: [],
    });
  });

  it("names GOOGLE_TRANSLATE_API_KEY as missing while the flag is on", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    const { captionsReadiness } = await import("@/lib/captions/config");
    const r = captionsReadiness();
    expect(r.enabled).toBe(false);
    expect(r.googleTranslate).toBe(false);
    expect(r.missing).toEqual(["GOOGLE_TRANSLATE_API_KEY"]);
  });
});

describe("warnIfCaptionsMisconfigured", () => {
  beforeEach(() => {
    warn.mockClear();
    vi.resetModules();
  });

  it("warns once, naming the missing key, when the flag is on but the key is absent", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");

    warnIfCaptionsMisconfigured();
    warnIfCaptionsMisconfigured();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ missing: ["GOOGLE_TRANSLATE_API_KEY"] });
  });

  it("stays silent when captions are correctly configured", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");
    warnIfCaptionsMisconfigured();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when the feature is deliberately off (flag unset) — a missing key is not a misconfig if nobody asked for captions", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    const { warnIfCaptionsMisconfigured } = await import("@/lib/captions/config");
    warnIfCaptionsMisconfigured();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is triggered as a side effect of liveCaptionsEnabled() resolving to unavailable — the chokepoint every caption surface hits", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    const { liveCaptionsEnabled } = await import("@/lib/captions/config");
    expect(liveCaptionsEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ missing: ["GOOGLE_TRANSLATE_API_KEY"] });
  });
});
