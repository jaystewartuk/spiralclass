import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Live Calls admin dashboard's LiveKit reads/actions (listActiveRooms,
// getRoomDetail, endRoom, disconnectParticipant) — added to the existing
// VideoProvider seam (packages/shared/src/rtc-provider.ts) alongside the
// pre-existing mintToken/listParticipants/recording methods this file already
// covers. What matters here: field mapping (bigint → number, enum → our own
// string unions), null on a genuinely-missing room, graceful degradation when
// listParticipants 404s on an otherwise-real room, and idempotent no-op
// (not a throw) when ending/disconnecting against something already gone.

const ParticipantInfo_State = { JOINING: 0, JOINED: 1, ACTIVE: 2, DISCONNECTED: 3 };
const TrackSource = {
  UNKNOWN: 0,
  CAMERA: 1,
  MICROPHONE: 2,
  SCREEN_SHARE: 3,
  SCREEN_SHARE_AUDIO: 4,
};
const TrackType = { AUDIO: 0, VIDEO: 1, DATA: 2 };

class TwirpError extends Error {
  status: number;
  code?: string;
  constructor(name: string, message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const listRooms = vi.fn();
const listParticipants = vi.fn();
const deleteRoom = vi.fn();
const removeParticipant = vi.fn();
// `new` on a vi.fn() mock forwards to its implementation since vitest 5, and an
// arrow function is not constructible — so these SDK client stubs are plain
// functions returning the stub object, which `new` then yields.
const RoomServiceClient = vi.fn(function () {
  return { listRooms, listParticipants, deleteRoom, removeParticipant };
});

vi.mock("livekit-server-sdk", () => ({
  RoomServiceClient,
  ParticipantInfo_State,
  TrackSource,
  TrackType,
  TwirpError,
}));

const { createLiveKitProvider } = await import("@/lib/video/providers/livekit-provider");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
});

afterEach(() => {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

function provider() {
  const p = createLiveKitProvider();
  if (!p) throw new Error("provider not configured in test");
  return p;
}

describe("listActiveRooms", () => {
  it("maps every active room, converting bigint creationTimeMs to number", async () => {
    listRooms.mockResolvedValueOnce([
      {
        name: "class-b1",
        sid: "RM_1",
        numParticipants: 2,
        numPublishers: 2,
        creationTimeMs: 1_700_000_000_000n,
      },
    ]);

    const rooms = await provider().listActiveRooms();

    expect(rooms).toEqual([
      {
        name: "class-b1",
        sid: "RM_1",
        numParticipants: 2,
        numPublishers: 2,
        creationTimeMs: 1_700_000_000_000,
      },
    ]);
    expect(listRooms).toHaveBeenCalledWith();
  });
});

describe("getRoomDetail", () => {
  it("returns null when the room doesn't exist", async () => {
    listRooms.mockResolvedValueOnce([]);
    expect(await provider().getRoomDetail("class-gone")).toBeNull();
    expect(listParticipants).not.toHaveBeenCalled();
  });

  it("merges room + participant data, mapping state/tracks to our own shapes", async () => {
    listRooms.mockResolvedValueOnce([
      {
        name: "class-b1",
        sid: "RM_1",
        numParticipants: 2,
        numPublishers: 1,
        creationTimeMs: 1_700_000_000_000n,
      },
    ]);
    listParticipants.mockResolvedValueOnce([
      {
        identity: "teacher-1",
        name: "Mira",
        sid: "PA_1",
        state: ParticipantInfo_State.ACTIVE,
        joinedAtMs: 1_700_000_001_000n,
        isPublisher: true,
        tracks: [
          { sid: "TR_cam", source: TrackSource.CAMERA, type: TrackType.VIDEO, muted: false },
          { sid: "TR_mic", source: TrackSource.MICROPHONE, type: TrackType.AUDIO, muted: true },
          {
            sid: "TR_screen",
            source: TrackSource.SCREEN_SHARE,
            type: TrackType.VIDEO,
            muted: false,
          },
        ],
      },
    ]);

    const detail = await provider().getRoomDetail("class-b1");

    expect(detail).toEqual({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: 1_700_000_000_000,
      numParticipants: 2,
      numPublishers: 1,
      participants: [
        {
          identity: "teacher-1",
          name: "Mira",
          sid: "PA_1",
          state: "active",
          joinedAtMs: 1_700_000_001_000,
          isPublisher: true,
          tracks: [
            { sid: "TR_cam", kind: "video", muted: false },
            { sid: "TR_mic", kind: "audio", muted: true },
            { sid: "TR_screen", kind: "screen_share", muted: false },
          ],
        },
      ],
    });
  });

  it("degrades to an empty participant list when listParticipants fails on a room that exists", async () => {
    listRooms.mockResolvedValueOnce([
      {
        name: "class-b1",
        sid: "RM_1",
        numParticipants: 0,
        numPublishers: 0,
        creationTimeMs: 1_700_000_000_000n,
      },
    ]);
    listParticipants.mockRejectedValueOnce(new Error("boom"));

    const detail = await provider().getRoomDetail("class-b1");

    expect(detail?.participants).toEqual([]);
  });
});

describe("endRoom", () => {
  it("deletes the room", async () => {
    deleteRoom.mockResolvedValueOnce(undefined);
    await provider().endRoom("class-b1");
    expect(deleteRoom).toHaveBeenCalledWith("class-b1");
  });

  it("is idempotent: swallows a not-found error", async () => {
    deleteRoom.mockRejectedValueOnce(new TwirpError("twirp", "not found", 404, "not_found"));
    await expect(provider().endRoom("class-gone")).resolves.toBeUndefined();
  });

  it("rethrows a genuine provider failure", async () => {
    deleteRoom.mockRejectedValueOnce(new TwirpError("twirp", "internal", 500));
    await expect(provider().endRoom("class-b1")).rejects.toThrow("internal");
  });
});

describe("disconnectParticipant", () => {
  it("removes the participant", async () => {
    removeParticipant.mockResolvedValueOnce(undefined);
    await provider().disconnectParticipant("class-b1", "teacher-1");
    expect(removeParticipant).toHaveBeenCalledWith("class-b1", "teacher-1");
  });

  it("is idempotent: swallows a not-found error", async () => {
    removeParticipant.mockRejectedValueOnce(new TwirpError("twirp", "not found", 404));
    await expect(provider().disconnectParticipant("class-b1", "gone")).resolves.toBeUndefined();
  });
});
