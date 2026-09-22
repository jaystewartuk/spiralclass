import { afterEach, describe, expect, it, vi } from "vitest";

import { introVideoCoachEnabled } from "@/lib/intro-video/config";

// The intro-video coach is dormant unless BOTH an explicit flag is on AND an ASR
// vendor is configured — a separate gate from the lesson-insights transcription
// flag (D-73). A misconfiguration can never quietly start spending ASR minutes.

afterEach(() => vi.unstubAllEnvs());

describe("introVideoCoachEnabled", () => {
  it("is false when the flag is off, even with a vendor key", () => {
    vi.stubEnv("INTRO_VIDEO_COACH_ENABLED", "");
    vi.stubEnv("DEEPGRAM_API_KEY", "dg_key");
    expect(introVideoCoachEnabled()).toBe(false);
  });

  it("is false when the flag is on but no vendor is configured", () => {
    vi.stubEnv("INTRO_VIDEO_COACH_ENABLED", "1");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    expect(introVideoCoachEnabled()).toBe(false);
  });

  it("is true only when the flag is on AND a vendor key is present", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg_key");
    for (const on of ["1", "true", "on"]) {
      vi.stubEnv("INTRO_VIDEO_COACH_ENABLED", on);
      expect(introVideoCoachEnabled()).toBe(true);
    }
  });
});
