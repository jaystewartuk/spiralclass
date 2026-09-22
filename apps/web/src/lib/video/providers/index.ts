import type { RtcProviderId, VideoProvider } from "@spiralclass/shared";
import { logger } from "@/lib/logger";
import { createLiveKitProvider } from "@/lib/video/providers/livekit-provider";

// The RTC_PROVIDER factory (docs/features/live-calls-video.md).
// Only "livekit" exists today; a second implementation
// (Daily, per the audit) is a sibling *-provider.ts file plus one more case
// here — no other file in the app changes to add it.

const log = logger({ surface: "rtc-provider" });

function resolveRtcProviderId(): RtcProviderId {
  // Non-secret, read straight off process.env like every other video-layer
  // availability check — never depends on the whole env schema validating.
  const raw = process.env.RTC_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "livekit") return "livekit";
  log.warn("unknown RTC_PROVIDER, falling back to livekit", { raw });
  return "livekit";
}

// Null when no provider is configured (dev/test, or before credentials are
// set in prod) — callers degrade to a friendly "not available" message,
// exactly like the AI summary without an Anthropic key.
export function getVideoProvider(): VideoProvider | null {
  const providerId = resolveRtcProviderId();
  switch (providerId) {
    case "livekit":
      return createLiveKitProvider();
    default: {
      const exhaustive: never = providerId;
      return exhaustive;
    }
  }
}
