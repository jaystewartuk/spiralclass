import { RoomServiceClient } from "livekit-server-sdk";
import type { AgentConfig } from "./config";
import { bookingIdFromRoomName } from "./config";
import { AppClient } from "./app-client";
import { RoomWorker } from "./room-worker";
import { isJoinCandidate, roomIsIdle } from "./room-lifecycle";
import { logEvent } from "./log";

type TrackedRoom = { worker: RoomWorker | null; lastConfigCheckAt: number };

// Polls RoomServiceClient.listRooms() for new class-call rooms rather than
// using LiveKit's Agent Dispatch job system — no new inbound port, no
// coupling to the app's webhook handler, fully self-contained on the box
// (same RoomServiceClient-polling pattern packages/livekit-activity-cli
// already uses successfully). A room that resolves as "not enabled" (Pro
// gate off, feature flag off, or not a class room at all) is retried on the
// slower roomConfigPollIntervalMs cooldown, not every discovery tick — cheap
// at today's scale (one teacher), but avoids a tight poll loop hammering the
// app for a room that will never caption.
export class Discovery {
  private readonly roomService: RoomServiceClient;
  private readonly appClient: AppClient;
  private readonly tracked = new Map<string, TrackedRoom>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: AgentConfig) {
    this.roomService = new RoomServiceClient(
      config.livekitUrl,
      config.livekitApiKey,
      config.livekitApiSecret,
    );
    this.appClient = new AppClient(config.appInternalBaseUrl, config.captionsAgentSharedSecret);
  }

  start(): void {
    this.timer = setInterval(() => void this.safeTick(), this.config.roomPollIntervalMs);
    void this.safeTick();
  }

  // tick() is fire-and-forget from a timer, so anything it throws becomes an
  // unhandled rejection and Node 22 kills the whole Agent — every room, not
  // just the one that failed. A poll tick failing is not worth that; log it
  // and let the next tick try again. (The known offender, a rejected fetch in
  // AppClient, is fixed at source too — this is the backstop for the next one.)
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      logEvent("discovery_tick_failed", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.tracked.values()].map((t) => t.worker?.stop()));
    this.tracked.clear();
  }

  private async tick(): Promise<void> {
    let rooms: Array<{ name: string; numParticipants?: number }>;
    try {
      rooms = await this.roomService.listRooms();
    } catch (err) {
      logEvent("list_rooms_failed", { error: String(err) });
      return;
    }
    const activeNames = new Set(rooms.map((r) => r.name));

    for (const [name, entry] of this.tracked) {
      if (!activeNames.has(name)) {
        await entry.worker?.stop();
        this.tracked.delete(name);
      }
    }

    for (const room of rooms) {
      if (!bookingIdFromRoomName(room.name)) continue;
      const entry = this.tracked.get(room.name);
      // Free pre-filter over what listRooms() already gave us: skips a room
      // we're already working, and one the server reports as outright empty.
      if (
        !isJoinCandidate({
          hasWorker: entry?.worker != null,
          numParticipants: room.numParticipants,
        })
      )
        continue;
      const now = Date.now();
      if (entry && now - entry.lastConfigCheckAt < this.config.roomConfigPollIntervalMs) continue;

      // Confirmation stage. numParticipants is a bare count that includes the
      // Agent and lags its own disconnect, so a room we just left still looks
      // occupied for a tick — rejoining on that stale count is what re-creates
      // the never-reaped-room deadlock (see room-lifecycle.ts). Identities
      // settle the question because roomIsIdle subtracts the Agent by name.
      // Costs one loopback RPC, and only for a room that already looks
      // occupied and has no worker — so in practice once, as a call ends.
      if (await this.roomHasNoHumans(room.name)) continue;

      const roomConfig = await this.appClient.roomConfig(room.name);
      this.tracked.set(room.name, { worker: null, lastConfigCheckAt: now });
      if (roomConfig?.enabled) {
        const worker = new RoomWorker(room.name, roomConfig, this.config, this.appClient, () =>
          // The worker left an idle room on its own — drop it so a rejoin
          // within empty_timeout isn't blocked by the config-poll cooldown.
          this.tracked.delete(room.name),
        );
        try {
          // false = it connected, found no humans after all, and left again.
          // Keep the {worker: null} entry set above so the config-poll
          // cooldown applies and we don't retry on the very next tick.
          if (await worker.start()) {
            this.tracked.set(room.name, { worker, lastConfigCheckAt: now });
          }
        } catch (err) {
          logEvent("room_join_failed", { room: room.name, error: String(err) });
        }
      }
    }
  }

  // Authoritative "is anyone actually in there?", used to confirm a join
  // candidate. Fails toward joining: if listParticipants can't be reached we
  // can't prove the room is empty, and captioning a live call matters more
  // than avoiding one leaked worker — the worker's own post-connect idle
  // check (room-worker.ts) is the backstop for that path.
  private async roomHasNoHumans(roomName: string): Promise<boolean> {
    try {
      const participants = await this.roomService.listParticipants(roomName);
      const idle = roomIsIdle(participants.map((p) => p.identity));
      if (idle) logEvent("skip_join_room_idle", { room: roomName });
      return idle;
    } catch (err) {
      logEvent("list_participants_failed", { room: roomName, error: String(err) });
      return false;
    }
  }
}
