// Env contract for the captions Agent. Deliberately minimal and read straight
// from process.env (no zod schema, no framework) — this is a small standalone
// service, not the Next.js app, so there's no shared env-validation layer to
// hook into. Throws at startup on anything missing rather than failing later
// mid-call, same "fail fast, loud, once" spirit as the app's own env.ts.

export type AgentConfig = {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  deepgramApiKey: string;
  appInternalBaseUrl: string;
  captionsAgentSharedSecret: string;
  // Translation calls Anthropic directly (see translate.ts) rather than
  // round-tripping through the app — removes a whole network hop from the
  // hot path. anthropicModel is the fallback/main model (mirrors the app's
  // ANTHROPIC_MODEL default); captionTranslationModel is the fast/cheap
  // model actually used per-line (mirrors CAPTION_TRANSLATION_MODEL).
  anthropicApiKey: string;
  anthropicModel: string;
  captionTranslationModel: string;
  // How often to poll RoomServiceClient.listRooms() for new class rooms.
  roomPollIntervalMs: number;
  // How often to re-check room-config (consent/language/entitlement) for
  // each room already being captioned — closes the "no live
  // consent-revocation" gap the old client-driven design had.
  roomConfigPollIntervalMs: number;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`livekit-captions-agent: missing required env var ${name}`);
  }
  return value;
}

export function loadConfig(): AgentConfig {
  return {
    livekitUrl: requireEnv("LIVEKIT_URL"),
    livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
    livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    appInternalBaseUrl: requireEnv("APP_INTERNAL_BASE_URL"),
    captionsAgentSharedSecret: requireEnv("CAPTIONS_AGENT_SHARED_SECRET"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
    captionTranslationModel: process.env.CAPTION_TRANSLATION_MODEL?.trim() || "claude-haiku-4-5",
    roomPollIntervalMs: Number(process.env.ROOM_POLL_INTERVAL_MS) || 3_000,
    roomConfigPollIntervalMs: Number(process.env.ROOM_CONFIG_POLL_INTERVAL_MS) || 60_000,
  };
}

// The Agent's own LiveKit participant identity — every room it joins, so a
// client can feature-detect "is the Agent in this room" and every published
// caption message's `for` field can be checked against it defensively.
//
// Re-exported from @spiralclass/shared rather than declared here: the web and
// mobile clients need the same value to exclude the Agent from "the other
// person in this call", and a second hand-maintained copy is exactly how that
// drifts apart silently.
export { CAPTIONS_AGENT_IDENTITY as AGENT_IDENTITY } from "@spiralclass/shared";

// Room-name prefix this Agent captions. Mirrors apps/web/src/lib/video/
// provider.ts's classCallRoom() — kept as a local literal rather than an
// import, since the Agent is a standalone deployable that doesn't depend on
// apps/web.
export const CLASS_ROOM_PREFIX = "class-";

export function bookingIdFromRoomName(room: string): string | null {
  return room.startsWith(CLASS_ROOM_PREFIX) ? room.slice(CLASS_ROOM_PREFIX.length) : null;
}
