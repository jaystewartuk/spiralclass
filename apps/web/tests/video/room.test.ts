import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lesson-insights audio egress needs each participant's *microphone* track
// SID, which only the room service can resolve mid-call. This checks the
// resolver picks the mic track (not camera/screenshare), skips participants with
// no published mic, and stays dormant (returns []) when LiveKit isn't configured.

const listParticipants = vi.fn();
// `new` on a vi.fn() mock forwards to its implementation since vitest 5, and an
// arrow function is not constructible — so these SDK client stubs are plain
// functions returning the stub object, which `new` then yields.
const RoomServiceClient = vi.fn(function () {
  return { listParticipants };
});

// Mirror the protocol enum values the resolver compares against.
const TrackSource = { UNKNOWN: 0, CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3 };

vi.mock("livekit-server-sdk", () => ({ RoomServiceClient, TrackSource }));

const { listParticipantMicTracks } = await import("@/lib/video/room");

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

describe("listParticipantMicTracks", () => {
  it("returns the mic track SID per participant, ignoring non-mic tracks", async () => {
    listParticipants.mockResolvedValueOnce([
      {
        identity: "teacher-1",
        tracks: [
          { sid: "TR_cam", source: TrackSource.CAMERA },
          { sid: "TR_mic_t", source: TrackSource.MICROPHONE },
        ],
      },
      {
        identity: "student-1",
        tracks: [{ sid: "TR_mic_s", source: TrackSource.MICROPHONE }],
      },
    ]);

    const tracks = await listParticipantMicTracks("class-b1");

    expect(tracks).toEqual([
      { identity: "teacher-1", trackId: "TR_mic_t" },
      { identity: "student-1", trackId: "TR_mic_s" },
    ]);
    expect(RoomServiceClient).toHaveBeenCalledWith("wss://example.livekit.cloud", "key", "secret");
    expect(listParticipants).toHaveBeenCalledWith("class-b1");
  });

  it("skips a participant with no published mic track", async () => {
    listParticipants.mockResolvedValueOnce([
      { identity: "camera-only", tracks: [{ sid: "TR_cam", source: TrackSource.CAMERA }] },
      { identity: "no-tracks", tracks: [] },
    ]);

    expect(await listParticipantMicTracks("class-b1")).toEqual([]);
  });

  it("returns [] when LiveKit isn't configured (feature dormant)", async () => {
    delete process.env.LIVEKIT_API_KEY;
    expect(await listParticipantMicTracks("class-b1")).toEqual([]);
    expect(RoomServiceClient).not.toHaveBeenCalled();
  });
});
