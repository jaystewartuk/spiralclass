import { AccessToken } from "livekit-server-sdk";
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackSource,
  type Participant,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { CAPTION_TOPIC, encodeCaption } from "@spiralclass/shared";
import type { AgentConfig } from "./config";
import { AGENT_IDENTITY } from "./config";
import type { AppClient, CaptionDirection, RoomConfig } from "./app-client";
import { DeepgramStream } from "./deepgram";
import { resolveSpeakerDirection, type SpeakerDirection } from "./direction";
import { buildCaptionLine } from "./caption-line";
import { isTeacher, captionedIdentities } from "./captions-toggle";
import { roomIsIdle } from "./room-lifecycle";
import { logEvent, UtteranceTiming } from "./log";
import { translateCaption } from "./translate";

// The client-side attribute the TEACHER's own client sets when she flips the
// call's "captions on" toggle (apps/web/src/lib/captions/use-live-captions.ts)
// — D-27 named this feature "teacher-toggled" from
// the start; only her attribute is ever trusted as the room's captions
// switch (see the ParticipantAttributesChanged listener below, which ignores
// this attribute from anyone else). A single flag then gates whether BOTH
// directions' audio gets forwarded to Deepgram/Anthropic at all — the Agent
// forking audio server-side does not, on its own, mean audio is sent
// externally regardless of the toggle. This was an explicit product/privacy
// choice, not an incidental
// default.
const CAPTIONS_ON_ATTRIBUTE = "captionsOn";

// Per-room orchestration: joins one class-call room, subscribes to each
// human participant's mic track (audio frames are always read off a
// subscribed track — required by the AudioStream API — but nothing is
// forwarded to Deepgram unless the TEACHER's captionsOn attribute is true
// AND consent/entitlement allow it for that specific speaker), translates
// each finalized segment via the app's internal API, and publishes the
// translated line to the OTHER participant only (see the protocol's `for`
// field, packages/shared/src/captions.ts). Deliberately does NOT replicate
// the old client-driven design's "speaker sees their own line" self-echo —
// that was a side effect of local publish-echo, not a considered product
// requirement.
export class RoomWorker {
  private readonly room = new Room();
  private readonly deepgramByIdentity = new Map<string, DeepgramStream>();
  // The room's single captions switch — only ever set from the teacher's own
  // attribute (captions-toggle.ts's isTeacher), never per-speaker.
  private captionsOn = false;
  // Guards against double-invocation between the TrackSubscribed listener and
  // the post-connect existing-publication sweep both catching the same track
  // (harmless individually, but calling consumeAudio twice for one identity
  // would start two competing AudioStream readers on the track).
  private readonly micHandledForIdentity = new Set<string>();
  // Monotonic counter behind every published line's id — see publish().
  private lineSeq = 0;
  private roomConfig: RoomConfig;
  private configPollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly roomName: string,
    initialConfig: RoomConfig,
    private readonly agentConfig: AgentConfig,
    private readonly appClient: AppClient,
    // Called once this worker has left a room whose humans have all gone, so
    // Discovery can stop tracking it (and re-join cleanly if someone comes
    // back before LiveKit's empty_timeout reaps the room).
    private readonly onIdle?: () => void,
  ) {
    this.roomConfig = initialConfig;
  }

  // Resolves true if this worker joined and stayed. False means it connected,
  // found the room already empty of humans, and left again — Discovery must
  // not track it as live (see its call site).
  async start(): Promise<boolean> {
    const at = new AccessToken(this.agentConfig.livekitApiKey, this.agentConfig.livekitApiSecret, {
      identity: AGENT_IDENTITY,
      ttl: "24h",
    });
    at.addGrant({ roomJoin: true, room: this.roomName, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      logEvent("track_subscribed", {
        room: this.roomName,
        identity: participant.identity,
        source: publication.source,
      });
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) return;
      this.handleMicTrack(track, participant);
    });
    this.room.on(RoomEvent.ParticipantAttributesChanged, (changedAttributes, participant) => {
      if (!(CAPTIONS_ON_ATTRIBUTE in changedAttributes)) return;
      // Only the teacher's own attribute controls the room's captions switch
      // (D-27) — a student client changing this attribute (stale build, or a
      // deliberately crafted one) is silently ignored rather than trusted.
      if (!isTeacher(this.roomConfig, participant.identity)) return;
      this.updateCaptioningOnState(participant);
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.deepgramByIdentity.get(participant.identity)?.close();
      this.deepgramByIdentity.delete(participant.identity);
      // Let a later rejoin re-run mic handling for this identity. Without
      // this, handleMicTrack's dedup guard treats the NEW track as already
      // handled and never starts a consumeAudio reader on it, so that
      // participant's audio is silently dead for the rest of the worker's
      // life — no frames reach Deepgram, no captions reach the other side,
      // and nothing logs an error. (Production, 2026-07-28: the teacher saw
      // no captions all call because the student's re-subscribed mic track
      // was skipped exactly this way.)
      this.micHandledForIdentity.delete(participant.identity);
      if (isTeacher(this.roomConfig, participant.identity)) {
        // The only participant who can flip the room's captions switch just
        // left — there's no "half on" state once she's gone.
        this.captionsOn = false;
        for (const stream of this.deepgramByIdentity.values()) stream.close();
        this.deepgramByIdentity.clear();
      }
      // Last human out: leave, so the room can actually go empty and
      // LiveKit's empty_timeout can reap it (see room-lifecycle.ts).
      if (roomIsIdle(this.room.remoteParticipants.keys(), participant.identity)) {
        void this.leaveIdleRoom();
      }
    });
    this.room.on(RoomEvent.Disconnected, () => {
      logEvent("room_disconnected", { room: this.roomName });
    });

    await this.room.connect(this.agentConfig.livekitUrl, token, {
      autoSubscribe: true,
      dynacast: false,
    });
    logEvent("room_joined", {
      room: this.roomName,
      existingParticipants: [...this.room.remoteParticipants.keys()],
    });

    // The last human can leave between Discovery confirming the room was
    // occupied and this connection completing. Nothing would ever correct
    // that on its own: ParticipantDisconnected never fires for someone who
    // was already gone, so roomIsIdle would never be re-evaluated and this
    // worker would hold an empty room open past empty_timeout forever. Check
    // once, here, where we finally have the real participant map.
    //
    // Deliberately stop() and not leaveIdleRoom(): the onIdle callback exists
    // to let a genuine rejoin skip Discovery's cooldown, which is precisely
    // wrong here — it would let the next tick retry immediately and flap.
    if (roomIsIdle(this.room.remoteParticipants.keys())) {
      logEvent("joined_idle_room_leaving", { room: this.roomName });
      await this.stop();
      return false;
    }

    // Belt-and-suspenders for a room the Agent joins AFTER both participants
    // are already publishing (e.g. every restart while a call is still up,
    // since the Agent reconnects into the SAME room name rather than a fresh
    // one): don't rely solely on RoomEvent.TrackSubscribed firing a "replay"
    // for tracks that predate this connection — walk currently-known
    // participants/publications directly and pick up anything already
    // subscribed (autoSubscribe: true above means LiveKit already
    // subscribed us, this just makes sure OUR handling runs for it too).
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        logEvent("existing_publication_seen", {
          room: this.roomName,
          identity: participant.identity,
          source: publication.source,
          subscribed: (publication as { subscribed?: boolean }).subscribed ?? null,
          hasTrack: publication.track != null,
        });
        if (
          publication.source === TrackSource.SOURCE_MICROPHONE &&
          (publication as { subscribed?: boolean }).subscribed &&
          publication.track
        ) {
          this.handleMicTrack(publication.track, participant);
        }
      }
    }

    this.configPollTimer = setInterval(() => {
      // Same fire-and-forget hazard as Discovery's tick: a throw here has no
      // caller to catch it, so it would take the whole Agent down rather than
      // just this room's config refresh.
      void this.refreshRoomConfig().catch((err) =>
        logEvent("refresh_room_config_failed", { room: this.roomName, error: String(err) }),
      );
    }, this.agentConfig.roomConfigPollIntervalMs);
    return true;
  }

  // Re-checks consent/entitlement periodically (closes the "no live
  // consent-revocation" gap the client-driven design had — that design only
  // ever checked consent once, at token-mint time). Re-syncs every currently
  // tracked participant against the new config, same as an attribute change.
  private async refreshRoomConfig(): Promise<void> {
    const next = await this.appClient.roomConfig(this.roomName);
    if (!next) return; // transient failure — keep the last known config, try again next tick
    this.roomConfig = next;
    for (const identity of new Set([
      ...captionedIdentities(next),
      ...this.deepgramByIdentity.keys(),
    ])) {
      this.syncDeepgramFor(identity);
    }
  }

  private handleMicTrack(track: unknown, participant: RemoteParticipant): void {
    if (this.micHandledForIdentity.has(participant.identity)) return;
    this.micHandledForIdentity.add(participant.identity);
    logEvent("mic_track_subscribed", { room: this.roomName, identity: participant.identity });
    if (isTeacher(this.roomConfig, participant.identity)) {
      // Pick up her already-set toggle value — e.g. the Agent restarted
      // mid-call and this is the post-connect replay of a track that
      // predates this connection (see start()'s belt-and-suspenders sweep).
      this.updateCaptioningOnState(participant);
    } else {
      // A non-teacher mic becoming available (the student joining/rejoining)
      // — sync using whatever the teacher's switch currently says, since
      // she's the only one who controls it (D-27).
      this.syncDeepgramFor(participant.identity);
    }
    void this.consumeAudio(track, participant);
  }

  private updateCaptioningOnState(participant: Participant): void {
    const on = participant.attributes[CAPTIONS_ON_ATTRIBUTE] === "true";
    logEvent("captions_toggle_seen", {
      room: this.roomName,
      identity: participant.identity,
      on,
      rawAttribute: participant.attributes[CAPTIONS_ON_ATTRIBUTE] ?? null,
    });
    this.captionsOn = on;
    // One switch now covers both directions — re-evaluate everyone it
    // applies to, not just whoever's attribute just changed.
    for (const identity of captionedIdentities(this.roomConfig)) {
      this.syncDeepgramFor(identity);
    }
  }

  // Starts or stops this participant's Deepgram session so it exactly
  // matches "should we currently be sending her audio externally?" — both
  // gates (the teacher's room-wide switch, and this speaker's own
  // consent/entitlement) must hold.
  private syncDeepgramFor(identity: string): void {
    const direction = resolveSpeakerDirection(this.roomConfig, identity);
    const shouldRun = direction != null && this.captionsOn;
    const existing = this.deepgramByIdentity.get(identity);
    logEvent("sync_deepgram", {
      room: this.roomName,
      identity,
      directionResolved: direction != null,
      captionsToggleOn: this.captionsOn,
      shouldRun,
      alreadyRunning: existing != null,
    });

    if (shouldRun && !existing) {
      const deepgram = new DeepgramStream(this.agentConfig.deepgramApiKey, direction.source, {
        onOpen: () => logEvent("deepgram_open", { room: this.roomName, identity }),
        onFinalTranscript: (text, audioEndAtMs) => {
          logEvent("deepgram_final_transcript", {
            room: this.roomName,
            identity,
            textLength: text.length,
            audioEndAtMs,
          });
          void this.onFinalTranscript(text, direction, audioEndAtMs, identity);
        },
        onError: (err) =>
          logEvent("deepgram_error", { room: this.roomName, identity, error: String(err) }),
      });
      this.deepgramByIdentity.set(identity, deepgram);
      return;
    }
    if (!shouldRun && existing) {
      existing.close();
      this.deepgramByIdentity.delete(identity);
    }
  }

  // Frames are always read off a subscribed mic track for the track's whole
  // lifetime (the AudioStream API requires a continuous consumer) — but a
  // frame is only ever forwarded to Deepgram while a session is actually
  // running for this identity (syncDeepgramFor above), so no audio leaves
  // the box unless the toggle+consent+entitlement gates are all open.
  private async consumeAudio(track: unknown, participant: RemoteParticipant): Promise<void> {
    const audioStream = new AudioStream(track as never, 16_000, 1);
    for await (const frame of audioStream) {
      if (this.stopped) break;
      this.deepgramByIdentity.get(participant.identity)?.send(frame.data);
    }
  }

  private async onFinalTranscript(
    text: string,
    direction: SpeakerDirection,
    audioEndAtMs: number | null,
    speakerIdentity: string,
  ): Promise<void> {
    // audioEndAtMs (from Deepgram's own start/duration fields) is the real
    // moment speech ended — using it as the timing baseline turns the first
    // mark() delta below into genuine ASR latency. Falls back to now() (the
    // old, ~0ms-always behavior) only if Deepgram omitted those fields.
    const timing = new UtteranceTiming(this.roomName, audioEndAtMs ?? Date.now());
    timing.mark("final");
    const translated = await translateCaption(this.agentConfig, text, {
      source: direction.source,
      target: direction.target,
    } satisfies CaptionDirection);
    timing.mark("translated");
    if (!translated) {
      logEvent("translate_failed", { room: this.roomName });
      timing.done();
      return;
    }
    await this.publish(translated, text, direction, speakerIdentity);
    logEvent("caption_published", {
      room: this.roomName,
      listenerIdentity: direction.listenerIdentity,
    });
    timing.mark("published");
    timing.done();
  }

  // The packet itself is built by buildCaptionLine (caption-line.ts) — pure,
  // and tested there — so this method is only the LiveKit send.
  private async publish(
    translated: string,
    source: string,
    direction: SpeakerDirection,
    speakerIdentity: string,
  ): Promise<void> {
    if (!this.room.localParticipant) return;
    const msg = buildCaptionLine({
      translated,
      source,
      direction,
      speakerIdentity,
      seq: this.lineSeq++,
      now: Date.now(),
    });
    await this.room.localParticipant.publishData(encodeCaption(msg), {
      reliable: true,
      topic: CAPTION_TOPIC,
      // The packet is addressed twice on purpose: `msg.for` is the
      // application-level check every receiver makes (a client cannot trust
      // that a packet on this topic was meant for it — the Agent is a third
      // participant), and this is the SFU-level routing that keeps it off the
      // other party's wire in the first place. Both read from the same
      // resolved direction, so they cannot disagree.
      destination_identities: [msg.for],
    });
  }

  // The call ended (every human left). Leave the room and tell Discovery to
  // forget it — holding the room open would keep it out of empty_timeout's
  // reach forever, which is the leak room-lifecycle.ts documents.
  private async leaveIdleRoom(): Promise<void> {
    if (this.stopped) return;
    logEvent("room_idle_leaving", { room: this.roomName });
    await this.stop();
    this.onIdle?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.configPollTimer) clearInterval(this.configPollTimer);
    for (const stream of this.deepgramByIdentity.values()) stream.close();
    this.deepgramByIdentity.clear();
    this.captionsOn = false;
    await this.room.disconnect();
    logEvent("room_left", { room: this.roomName });
  }
}
