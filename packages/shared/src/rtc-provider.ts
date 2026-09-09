// The provider-agnostic seam for the in-class video call (D-16, extended per
// docs/features/live-calls-video.md). Promoted to
// packages/shared — rather than living only in apps/web as VideoProvider did
// before this — so a future second implementation (and, eventually, mobile)
// can reference the same types. Today only
// apps/web/src/lib/video/providers/livekit-provider.ts implements
// `VideoProvider`.
//
// Deliberately scoped to the SERVER-SIDE control plane: token minting,
// recording orchestration, participant introspection, and webhook
// normalization. The client-side media SDK (join/leave/publish/mute) is NOT
// abstracted here — the video architecture audit explains why that's a considered
// omission (no real prior art for that pattern, and recording + event
// semantics are exactly where it would leak hardest across providers), not an
// oversight.

export type RtcProviderId = "livekit";

export type CallGrant = {
  // Media server websocket URL the client connects to. Returned per-call
  // rather than exposed as a public env so it travels with the (short-lived)
  // token.
  url: string;
  token: string;
};

export type MintOptions = {
  // Room name — one room per booking.
  room: string;
  // Stable participant identity (the user id).
  identity: string;
  // Display name shown to the other participant.
  name: string;
};

export type ParticipantInfo = {
  identity: string;
  // The participant's published, unmuted microphone track id, or null if they
  // have none — e.g. a participant with only a camera track still appears
  // here with micTrackId: null, not omitted.
  micTrackId: string | null;
};

// ---- Admin observability (Live Calls admin dashboard) -------------------
//
// Deliberately a SEPARATE, coarser shape from ParticipantInfo above rather
// than extending it: ParticipantInfo is the lesson-insights/nudge seam's
// narrow "which mic track" question, answered for every provider identically.
// The admin dashboard instead wants "what's happening in this room right
// now" — connection state, every published track, publish/subscribe
// capability — which is real, provider-reported data (LiveKit's
// RoomServiceClient exposes exactly this), NOT synthetic client-side RTC
// stats (RTT/packet loss/jitter are only ever observable from inside a
// joined client, never from the server control plane — no provider
// implementation here should fabricate those).

export type RoomSummary = {
  name: string;
  sid: string;
  numParticipants: number;
  numPublishers: number;
  creationTimeMs: number;
};

export type ParticipantTrackKind =
  "audio" | "video" | "screen_share" | "screen_share_audio" | "unknown";

export type ParticipantTrackSummary = {
  sid: string;
  kind: ParticipantTrackKind;
  muted: boolean;
};

export type ParticipantConnectionState = "joining" | "joined" | "active" | "disconnected";

export type RoomParticipantDetail = {
  identity: string;
  name: string;
  sid: string;
  state: ParticipantConnectionState;
  joinedAtMs: number;
  // Whether this participant currently has an active publisher connection —
  // a participant who joined to only watch (rare, but possible with a
  // subscribe-only token) shows false.
  isPublisher: boolean;
  tracks: ParticipantTrackSummary[];
};

export type RoomDetail = {
  name: string;
  sid: string;
  creationTimeMs: number;
  numParticipants: number;
  numPublishers: number;
  participants: RoomParticipantDetail[];
};

export type RecordingHandle = {
  providerRecordingId: string;
  storageKey: string;
};

export type NormalizedVideoEvent =
  | {
      kind: "recording_ended";
      room: string | null;
      providerRecordingId: string;
      failed: boolean;
      durationMs: number | null;
    }
  | { kind: "room_finished"; room: string }
  // A room became active — LiveKit's `room_started`. Used for the
  // call_started analytics signal; never gates recording/capture (that's
  // participant-scoped, below).
  | { kind: "room_started"; room: string }
  // A participant joined — the trigger for auto-starting per-participant
  // lesson-audio capture (independent of the visible A/V recording toggle;
  // see lib/video/call-recording.ts's maybeStartLessonAudioCapture) and for
  // the call_started analytics signal when it's the earliest join.
  | { kind: "participant_joined"; room: string; identity: string | null }
  | { kind: "participant_left"; room: string; identity: string | null }
  // Egress accepted a recording start — distinct from recording_ended.
  | { kind: "egress_started"; room: string | null; providerRecordingId: string }
  | { kind: "unhandled"; room: string | null };

export type ParsedWebhookEvent = {
  // Provider-issued event id (or a synthesized fallback) — used for the
  // shared webhook_events dedup log, keyed by (provider id, eventId).
  eventId: string;
  eventType: string;
  event: NormalizedVideoEvent;
};

export interface VideoProvider {
  readonly id: RtcProviderId;

  mintToken(opts: MintOptions): Promise<CallGrant>;

  listParticipants(room: string): Promise<ParticipantInfo[]>;

  // Every currently-active room across the whole project — the Live Calls
  // admin dashboard's primary read. Empty array when nothing is live; never
  // throws for "no rooms", only for a genuine provider/network failure.
  listActiveRooms(): Promise<RoomSummary[]>;

  // Full operational detail for one room, including every participant's
  // tracks and connection state. Null if the room doesn't exist (already
  // ended, or never existed) — callers should treat that as "not live
  // anymore", not an error.
  getRoomDetail(room: string): Promise<RoomDetail | null>;

  // Force-ends a room, disconnecting every participant. Idempotent: ending
  // an already-gone room is a no-op, not an error.
  endRoom(room: string): Promise<void>;

  // Force-disconnects a single participant; the room itself stays open.
  // Idempotent for the same reason as endRoom.
  disconnectParticipant(room: string, identity: string): Promise<void>;

  // Whether this provider instance can currently record — its recording
  // backend and storage destination are fully configured. Layered under the
  // CLASS_RECORDING_ENABLED kill-switch by lib/video/recording.ts's
  // recordingEnabled(); this method only reports configuration, never consent.
  recordingConfigured(): boolean;

  startRoomRecording(room: string, storageKey: string): Promise<RecordingHandle>;
  startParticipantRecording(
    room: string,
    trackId: string,
    storageKey: string,
  ): Promise<RecordingHandle>;
  stopRecording(providerRecordingId: string): Promise<void>;

  // Verifies the webhook signature and normalizes the provider's event shape.
  // Throws on an invalid/unverifiable signature — callers should turn that
  // into a 401, not swallow it.
  parseWebhookEvent(rawBody: string, authHeader: string | null): Promise<ParsedWebhookEvent>;
}
