import {
  AccessToken,
  DirectFileOutput,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  ParticipantInfo_State,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  TrackType,
  TwirpError,
  WebhookReceiver,
} from "livekit-server-sdk";
import type {
  CallGrant,
  MintOptions,
  ParsedWebhookEvent,
  ParticipantConnectionState,
  ParticipantInfo,
  ParticipantTrackKind,
  RecordingHandle,
  RoomDetail,
  RoomSummary,
  VideoProvider,
} from "@spiralclass/shared";
import { r2BucketConfig } from "@/lib/storage/provider";

// The LiveKit implementation of the VideoProvider seam
// (docs/features/live-calls-video.md, extending D-16). Every
// direct livekit-server-sdk call in the video layer lives HERE now —
// lib/video/room.ts, lib/video/recording.ts, and the webhook route all route
// through this instead of constructing their own SDK clients, so a future
// second provider (Daily, per the audit) is a sibling file, not a rewrite of
// those three call sites.

type LiveKitConfig = { url: string; apiKey: string; apiSecret: string };

// Reads straight off process.env (not serverEnv()) so an availability check
// never depends on the whole env schema validating — same rationale every
// LiveKit call site used before this refactor, kept for the same reason.
function liveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

type EgressConfig = LiveKitConfig & {
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secret: string;
};

// R2 config (bucket = "recordings" in storage/provider.ts's R2_ENV_PREFIX map,
// backed by LIVEKIT_EGRESS_S3_* — the "S3" is historical, named for the
// egress feature).
function egressConfig(): EgressConfig | null {
  const cfg = liveKitConfig();
  if (!cfg) return null;
  const r2 = r2BucketConfig("recordings");
  if (!r2) return null;
  return {
    ...cfg,
    bucket: r2.bucket,
    endpoint: `https://${r2.host}`,
    region: r2.region,
    accessKey: r2.accessKey,
    secret: r2.secret,
  };
}

// Lazily evaluated (never at module scope) so importing this file doesn't
// require every livekit-server-sdk export to be present — several unit tests
// mock only the symbols their own scenario touches.
function isFailedEgressStatus(status: EgressStatus | undefined): boolean {
  if (status === undefined) return false;
  return (
    status === EgressStatus.EGRESS_FAILED ||
    status === EgressStatus.EGRESS_ABORTED ||
    status === EgressStatus.EGRESS_LIMIT_REACHED
  );
}

// LiveKit reports file duration in nanoseconds (int64). Round to whole ms;
// null when the egress produced no file result (e.g. a failed egress).
function durationMsOf(info: { fileResults?: Array<{ duration?: bigint }> }): number | null {
  const ns = info.fileResults?.[0]?.duration;
  if (ns === undefined || ns === null) return null;
  return Math.round(Number(ns) / 1_000_000);
}

// A function rather than a `Record` keyed by the enum's values — several
// unit tests mock "livekit-server-sdk" with only the symbols their own
// scenario touches, and a module-scope object literal keyed by
// `ParticipantInfo_State.JOINING` etc. would evaluate (and throw on
// `undefined` keys) at import time for every one of them.
function participantStateOf(state: ParticipantInfo_State): ParticipantConnectionState {
  if (state === ParticipantInfo_State.JOINED) return "joined";
  if (state === ParticipantInfo_State.ACTIVE) return "active";
  if (state === ParticipantInfo_State.DISCONNECTED) return "disconnected";
  return "joining";
}

function trackKindOf(source: TrackSource, type: TrackType): ParticipantTrackKind {
  if (source === TrackSource.SCREEN_SHARE) return "screen_share";
  if (source === TrackSource.SCREEN_SHARE_AUDIO) return "screen_share_audio";
  if (type === TrackType.VIDEO) return "video";
  if (type === TrackType.AUDIO) return "audio";
  return "unknown";
}

// True when a Twirp call failed because the target (room/participant)
// doesn't exist server-side — the shape a caller should treat as "already
// gone", not a real failure.
function isNotFoundError(err: unknown): boolean {
  return err instanceof TwirpError && (err.status === 404 || err.code === "not_found");
}

export class LiveKitProvider implements VideoProvider {
  readonly id = "livekit" as const;

  constructor(private readonly cfg: LiveKitConfig) {}

  async mintToken(opts: MintOptions): Promise<CallGrant> {
    const at = new AccessToken(this.cfg.apiKey, this.cfg.apiSecret, {
      identity: opts.identity,
      name: opts.name,
      // Comfortably longer than a class; the page mints a fresh one each visit.
      ttl: "2h",
    });
    at.addGrant({
      roomJoin: true,
      room: opts.room,
      canPublish: true,
      canSubscribe: true,
      // The class-call UI flips its own `captionsOn` participant attribute via
      // localParticipant.setAttributes() when the caption toggle is tapped —
      // without this grant, LiveKit's server rejects that call with
      // "does not have permission to update own metadata" (a
      // SignalRequestError, silently swallowed client-side as an unhandled
      // rejection), so the attribute never actually changes and the
      // server-side captions Agent (packages/livekit-captions-agent) never
      // sees the toggle at all — confirmed via a live Sentry event
      // (SPIRALCLASS-MOBILE-M) during the Agent migration's end-to-end test.
      canUpdateOwnMetadata: true,
    });
    const token = await at.toJwt();
    return { url: this.cfg.url, token };
  }

  async listParticipants(room: string): Promise<ParticipantInfo[]> {
    const client = new RoomServiceClient(this.cfg.url, this.cfg.apiKey, this.cfg.apiSecret);
    const participants = await client.listParticipants(room);
    return participants.map((p) => {
      const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
      return { identity: p.identity, micTrackId: mic?.sid ?? null };
    });
  }

  async listActiveRooms(): Promise<RoomSummary[]> {
    const client = new RoomServiceClient(this.cfg.url, this.cfg.apiKey, this.cfg.apiSecret);
    const rooms = await client.listRooms();
    return rooms.map((r) => ({
      name: r.name,
      sid: r.sid,
      numParticipants: r.numParticipants,
      numPublishers: r.numPublishers,
      creationTimeMs: Number(r.creationTimeMs),
    }));
  }

  async getRoomDetail(room: string): Promise<RoomDetail | null> {
    const client = new RoomServiceClient(this.cfg.url, this.cfg.apiKey, this.cfg.apiSecret);

    // listRooms(names) is how the server API answers "does this exist",
    // giving room-level fields listParticipants doesn't carry (sid, creation
    // time, publisher count) in the same round trip.
    const [found] = await client.listRooms([room]);
    if (!found) return null;

    // A room with zero participants can 404 on some LiveKit versions (see
    // lib/video/room.ts's listRoomParticipantIdentities) — treat that as
    // "no participants," not "room is gone," since listRooms just confirmed
    // it exists.
    const participants = await client.listParticipants(room).catch(() => []);

    return {
      name: found.name,
      sid: found.sid,
      creationTimeMs: Number(found.creationTimeMs),
      numParticipants: found.numParticipants,
      numPublishers: found.numPublishers,
      participants: participants.map((p) => this.toParticipantDetail(p)),
    };
  }

  async endRoom(room: string): Promise<void> {
    const client = new RoomServiceClient(this.cfg.url, this.cfg.apiKey, this.cfg.apiSecret);
    try {
      await client.deleteRoom(room);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async disconnectParticipant(room: string, identity: string): Promise<void> {
    const client = new RoomServiceClient(this.cfg.url, this.cfg.apiKey, this.cfg.apiSecret);
    try {
      await client.removeParticipant(room, identity);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  private toParticipantDetail(p: {
    identity: string;
    name: string;
    sid: string;
    state: ParticipantInfo_State;
    joinedAtMs: bigint;
    isPublisher: boolean;
    tracks: Array<{ sid: string; source: TrackSource; type: TrackType; muted: boolean }>;
  }) {
    return {
      identity: p.identity,
      name: p.name,
      sid: p.sid,
      state: participantStateOf(p.state),
      joinedAtMs: Number(p.joinedAtMs),
      isPublisher: p.isPublisher,
      tracks: p.tracks.map((t) => ({
        sid: t.sid,
        kind: trackKindOf(t.source, t.type),
        muted: t.muted,
      })),
    };
  }

  recordingConfigured(): boolean {
    return egressConfig() !== null;
  }

  // AUDIO-ONLY since 2026-08-27 (D-135). This used to composite video too, at
  // LiveKit's default H264_720P_30 preset, which produced 846 MB for a single
  // 51-minute class and dropped 2,586 video frames doing it — the 2-OCPU ARM box
  // also runs livekit-server, Redis, Caddy and the captions agent, and video
  // compositing is the expensive part of that workload. It was also the largest
  // and most sensitive thing the platform accumulated with no retention policy,
  // on a product whose students can be minors.
  //
  // What is lost is a video replay of the class; what is not lost is anything
  // the insights pipeline uses, which has always been a SEPARATE per-participant
  // audio egress (startParticipantRecording below), never this file.
  //
  // MP4/AAC rather than OGG/Opus deliberately, even though lessonAudioKey uses
  // OGG: this file is played back by a real person in a browser, and WebKit only
  // gained Ogg support in Safari 17.5. The teacher is on iOS. The `.m4a`
  // extension is what tells the replay viewer this is audio — legacy `.mp4` rows
  // recorded before this change are still video and still play as video.
  async startRoomRecording(room: string, storageKey: string): Promise<RecordingHandle> {
    const cfg = this.requireEgress();
    const client = new EgressClient(cfg.url, cfg.apiKey, cfg.apiSecret);
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: storageKey,
      output: { case: "s3", value: this.s3Upload(cfg) },
    });
    const info = await client.startRoomCompositeEgress(room, { file: output }, { audioOnly: true });
    return { providerRecordingId: info.egressId, storageKey };
  }

  async startParticipantRecording(
    room: string,
    trackId: string,
    storageKey: string,
  ): Promise<RecordingHandle> {
    const cfg = this.requireEgress();
    const client = new EgressClient(cfg.url, cfg.apiKey, cfg.apiSecret);
    const output = new DirectFileOutput({
      filepath: storageKey,
      output: { case: "s3", value: this.s3Upload(cfg) },
    });
    const info = await client.startTrackEgress(room, output, trackId);
    return { providerRecordingId: info.egressId, storageKey };
  }

  async stopRecording(providerRecordingId: string): Promise<void> {
    const cfg = egressConfig();
    if (!cfg) return; // nothing configured to stop against — best-effort.
    const client = new EgressClient(cfg.url, cfg.apiKey, cfg.apiSecret);
    await client.stopEgress(providerRecordingId);
  }

  async parseWebhookEvent(rawBody: string, authHeader: string | null): Promise<ParsedWebhookEvent> {
    const receiver = new WebhookReceiver(this.cfg.apiKey, this.cfg.apiSecret);
    const raw = await receiver.receive(rawBody, authHeader ?? undefined);

    // LiveKit stamps a unique event uuid; fall back to event+egressId so a
    // delivery that's missing one still dedups sanely.
    const eventId = raw.id || `${raw.event}:${raw.egressInfo?.egressId ?? ""}`;
    // Egress webhooks (`egress_started` / `egress_updated` / `egress_ended`)
    // carry NO top-level `room` object — the room they belong to is
    // `egressInfo.roomName`. Reading only `raw.room` meant every egress event
    // reached handleNormalizedEvent with `room: null`, and its `egress_started`
    // branch drops anything whose room isn't a class room, so
    // `call_recording_started` could NEVER fire. Confirmed in production on
    // 2026-08-27: livekit-server logged `sent webhook {"event":
    // "egress_started", ...}` for two real, successful recordings and PostHog
    // recorded neither.
    // `||` rather than `??` on purpose: both fields are plain `string` in the
    // protobuf and are the EMPTY STRING, not undefined, when unset.
    const room = raw.room?.name || raw.egressInfo?.roomName || null;

    if (raw.event === "egress_ended" && raw.egressInfo?.egressId) {
      return {
        eventId,
        eventType: raw.event,
        event: {
          kind: "recording_ended",
          room,
          providerRecordingId: raw.egressInfo.egressId,
          failed: isFailedEgressStatus(raw.egressInfo.status),
          durationMs: durationMsOf(raw.egressInfo),
        },
      };
    }

    if (raw.event === "room_finished" && room) {
      return { eventId, eventType: raw.event, event: { kind: "room_finished", room } };
    }

    if (raw.event === "room_started" && room) {
      return { eventId, eventType: raw.event, event: { kind: "room_started", room } };
    }

    if (raw.event === "participant_joined" && room) {
      return {
        eventId,
        eventType: raw.event,
        event: { kind: "participant_joined", room, identity: raw.participant?.identity ?? null },
      };
    }

    if (raw.event === "participant_left" && room) {
      return {
        eventId,
        eventType: raw.event,
        event: { kind: "participant_left", room, identity: raw.participant?.identity ?? null },
      };
    }

    if (raw.event === "egress_started" && raw.egressInfo?.egressId) {
      return {
        eventId,
        eventType: raw.event,
        event: { kind: "egress_started", room, providerRecordingId: raw.egressInfo.egressId },
      };
    }

    return { eventId, eventType: raw.event, event: { kind: "unhandled", room } };
  }

  private requireEgress(): EgressConfig {
    const cfg = egressConfig();
    if (!cfg) throw new Error("recording-not-configured");
    return cfg;
  }

  private s3Upload(cfg: EgressConfig): S3Upload {
    return new S3Upload({
      accessKey: cfg.accessKey,
      secret: cfg.secret,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
    });
  }
}

export function createLiveKitProvider(): LiveKitProvider | null {
  const cfg = liveKitConfig();
  return cfg ? new LiveKitProvider(cfg) : null;
}
