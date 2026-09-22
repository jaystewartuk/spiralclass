import type { CallGrant, MintOptions, VideoProvider } from "@spiralclass/shared";
import { getVideoProvider as resolveVideoProvider } from "@/lib/video/providers";

// Owning the in-class video call (live-notes-panel.md step 3, D-16). The media
// transport lives behind this seam so the differentiated part — a platform call
// the live-notes panel overlays — never depends on a specific provider.
//
// As of docs/features/live-calls-video.md, the
// VideoProvider TYPE lives in @spiralclass/shared and the concrete
// implementations live under lib/video/providers/ — this file re-exports
// getVideoProvider() and the types for every existing call site (so none of
// them had to change), plus the room-naming helpers below, which stay
// provider-agnostic. A different provider (or peer-to-peer) is a sibling
// implementation under providers/, selected via the RTC_PROVIDER env var — see
// providers/index.ts.

export type { CallGrant, MintOptions, VideoProvider };

// One room per booking. Prefixed so a room name can never collide with another
// kind of id and is obvious in provider dashboards/logs.
export function classCallRoom(bookingId: string): string {
  return `class-${bookingId}`;
}

// Inverse of classCallRoom: recover the booking id from a room name (e.g. the
// LiveKit egress webhook reports the room, not the booking). Null if the name
// isn't one of ours.
export function bookingIdFromCallRoom(room: string): string | null {
  const prefix = "class-";
  return room.startsWith(prefix) ? room.slice(prefix.length) : null;
}

// Null when no provider is configured (dev/test, or before credentials are set
// in prod) — callers degrade to a friendly "not available" message, exactly
// like the AI summary without an Anthropic key.
export function getVideoProvider(): VideoProvider | null {
  return resolveVideoProvider();
}
