import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The RTC_PROVIDER factory (docs/features/live-calls-video.md
// the video architecture audit). Covers: default/explicit "livekit" resolves to the
// LiveKit implementation, an unknown value falls back to LiveKit (never
// throws — a typo in the env var shouldn't take the call surface down), and
// the factory still returns null when LiveKit itself isn't configured
// (delegated, not re-implemented, by createLiveKitProvider()).

const AccessToken = vi.fn(() => ({ addGrant: vi.fn(), toJwt: vi.fn(async () => "jwt") }));
vi.mock("livekit-server-sdk", () => ({ AccessToken }));

const { getVideoProvider } = await import("@/lib/video/providers");

const ENV_VARS = ["RTC_PROVIDER", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
});

function configureLiveKit() {
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
}

describe("getVideoProvider", () => {
  it("defaults to livekit when RTC_PROVIDER is unset", () => {
    configureLiveKit();
    const provider = getVideoProvider();
    expect(provider?.id).toBe("livekit");
  });

  it("resolves livekit explicitly", () => {
    configureLiveKit();
    process.env.RTC_PROVIDER = "livekit";
    expect(getVideoProvider()?.id).toBe("livekit");
  });

  it("falls back to livekit for an unknown value rather than throwing", () => {
    configureLiveKit();
    process.env.RTC_PROVIDER = "daily";
    expect(() => getVideoProvider()).not.toThrow();
    expect(getVideoProvider()?.id).toBe("livekit");
  });

  it("is null when the resolved provider isn't configured", () => {
    process.env.RTC_PROVIDER = "livekit";
    expect(getVideoProvider()).toBeNull();
  });
});
