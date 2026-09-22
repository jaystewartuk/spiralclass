import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/live-calls/service.ts joins raw LiveKit room/participant data with
// SpiralClass's booking/teacher/student rows. What matters:
// - the list read stays cheap (ONE listRooms call, no per-room LiveKit call,
//   batched Prisma queries) and computes the dashboard aggregates correctly;
// - null propagates when no video provider is configured (dormant, not an
//   error — see getVideoProvider()'s own contract);
// - room→booking classification and teacher/student role
//   resolution are correct, including the "unknown room" fallback;
// - the end/disconnect actions call the provider, audit via writeOverride
//   with the right targetType/targetId, and report the right failure reason
//   without ever throwing.

const listActiveRooms = vi.fn();
const getRoomDetail = vi.fn();
const endRoom = vi.fn();
const disconnectParticipant = vi.fn();
let provider: unknown = {
  listActiveRooms,
  getRoomDetail,
  endRoom,
  disconnectParticipant,
};
const getVideoProvider = vi.fn(() => provider);
vi.mock("@/lib/video/providers", () => ({ getVideoProvider: () => getVideoProvider() }));

type PartyRow = {
  id: string;
  teacher: { id: string; name: string };
  student: { id: string; name: string };
};

const bookingFindMany = vi.fn(async (..._a: unknown[]): Promise<PartyRow[]> => []);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: (...a: unknown[]) => bookingFindMany(...a) },
  },
}));

const writeOverride = vi.fn(async (..._a: unknown[]) => "override-1");
vi.mock("@/lib/audit", () => ({ writeOverride: (...a: unknown[]) => writeOverride(...a) }));

const { listActiveCalls, getCallDetail, endCall, disconnectCallParticipant } =
  await import("@/lib/live-calls/service");

const NOW = 1_700_000_100_000;
const ACTOR = { id: "admin-1", email: "a@b.co", role: "support" as const };

beforeEach(() => {
  vi.clearAllMocks();
  provider = { listActiveRooms, getRoomDetail, endRoom, disconnectParticipant };
  getVideoProvider.mockImplementation(() => provider);
  bookingFindMany.mockResolvedValue([]);
  writeOverride.mockResolvedValue("override-1");
});

afterEach(() => vi.restoreAllMocks());

describe("listActiveCalls", () => {
  it("returns null when no video provider is configured", async () => {
    provider = null;
    getVideoProvider.mockImplementation(() => null);
    expect(await listActiveCalls(NOW)).toBeNull();
    expect(listActiveRooms).not.toHaveBeenCalled();
  });

  it("resolves teacher/student for a class room via one batched booking query", async () => {
    listActiveRooms.mockResolvedValueOnce([
      {
        name: "class-b1",
        sid: "RM_1",
        numParticipants: 2,
        numPublishers: 2,
        creationTimeMs: NOW - 60_000,
      },
    ]);
    bookingFindMany.mockResolvedValueOnce([
      {
        id: "b1",
        teacher: { id: "t1", name: "Mira" },
        student: { id: "s1", name: "Beto" },
      },
    ]);

    const result = await listActiveCalls(NOW);

    expect(result?.rooms).toEqual([
      {
        room: "class-b1",
        kind: "class",
        bookingId: "b1",
        teacher: { id: "t1", name: "Mira" },
        student: { id: "s1", name: "Beto" },
        numParticipants: 2,
        numPublishers: 2,
        createdAtMs: NOW - 60_000,
        durationSec: 60,
        fullyConnected: true,
      },
    ]);
    expect(bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["b1"] } } }),
    );
  });

  it("computes dashboard aggregates across mixed full/waiting rooms", async () => {
    listActiveRooms.mockResolvedValueOnce([
      { name: "class-b1", sid: "RM_1", numParticipants: 2, numPublishers: 2, creationTimeMs: NOW },
      { name: "class-b2", sid: "RM_2", numParticipants: 1, numPublishers: 1, creationTimeMs: NOW },
      {
        name: "unknown-room",
        sid: "RM_3",
        numParticipants: 0,
        numPublishers: 0,
        creationTimeMs: NOW,
      },
    ]);

    const result = await listActiveCalls(NOW);

    expect(result?.dashboard).toEqual({
      activeRooms: 3,
      activeParticipants: 3,
      roomsFullyConnected: 1,
      roomsWaitingForCounterpart: 2,
      avgParticipantsPerRoom: 1,
      lastUpdatedMs: NOW,
    });
    // The room name doesn't match either our own naming convention.
    expect(result?.rooms.find((r) => r.room === "unknown-room")?.kind).toBe("unknown");
  });
});

describe("getCallDetail", () => {
  it("returns null when the room is gone", async () => {
    getRoomDetail.mockResolvedValueOnce(null);
    expect(await getCallDetail("class-b1", NOW)).toBeNull();
  });

  it("resolves each participant's role by matching identity to teacher/student id", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: NOW - 30_000,
      numParticipants: 2,
      numPublishers: 2,
      participants: [
        {
          identity: "t1",
          name: "Mira",
          sid: "PA_1",
          state: "active",
          joinedAtMs: NOW - 20_000,
          isPublisher: true,
          tracks: [{ sid: "TR1", kind: "audio", muted: false }],
        },
        {
          identity: "s1",
          name: "Beto",
          sid: "PA_2",
          state: "active",
          joinedAtMs: NOW - 10_000,
          isPublisher: true,
          tracks: [
            { sid: "TR2", kind: "video", muted: false },
            { sid: "TR3", kind: "screen_share", muted: false },
          ],
        },
      ],
    });
    bookingFindMany.mockResolvedValueOnce([
      { id: "b1", teacher: { id: "t1", name: "Mira" }, student: { id: "s1", name: "Beto" } },
    ]);

    const detail = await getCallDetail("class-b1", NOW);

    expect(detail?.participants).toEqual([
      {
        identity: "t1",
        name: "Mira",
        role: "teacher",
        state: "active",
        joinedAtMs: NOW - 20_000,
        durationSec: 20,
        isPublisher: true,
        audioPublishing: true,
        videoPublishing: false,
        screenSharing: false,
      },
      {
        identity: "s1",
        name: "Beto",
        role: "student",
        state: "active",
        joinedAtMs: NOW - 10_000,
        durationSec: 10,
        isPublisher: true,
        audioPublishing: false,
        videoPublishing: true,
        screenSharing: true,
      },
    ]);
  });
});

describe("endCall", () => {
  it("returns unavailable when no provider is configured", async () => {
    provider = null;
    getVideoProvider.mockImplementation(() => null);
    expect(await endCall("class-b1", ACTOR, "stuck")).toEqual({ ok: false, reason: "unavailable" });
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("returns not-found without calling endRoom when the room is already gone", async () => {
    getRoomDetail.mockResolvedValueOnce(null);
    expect(await endCall("class-b1", ACTOR, "stuck")).toEqual({ ok: false, reason: "not-found" });
    expect(endRoom).not.toHaveBeenCalled();
  });

  it("ends the room and audits with the resolved booking id as targetId", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: NOW,
      numParticipants: 2,
      numPublishers: 2,
      participants: [
        {
          identity: "t1",
          name: "Mira",
          sid: "PA_1",
          state: "active",
          joinedAtMs: NOW,
          isPublisher: true,
          tracks: [],
        },
      ],
    });
    bookingFindMany.mockResolvedValueOnce([
      { id: "b1", teacher: { id: "t1", name: "Mira" }, student: { id: "s1", name: "Beto" } },
    ]);
    endRoom.mockResolvedValueOnce(undefined);

    const result = await endCall("class-b1", ACTOR, "stuck room");

    expect(result).toEqual({ ok: true });
    expect(endRoom).toHaveBeenCalledWith("class-b1");
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: "t1",
        targetType: "call",
        targetId: "b1",
        action: "end_call",
        reason: "stuck room",
        actor: ACTOR,
      }),
    );
  });

  it("falls back to the nil sentinel targetId for an unresolvable room", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "mystery-room",
      sid: "RM_9",
      creationTimeMs: NOW,
      numParticipants: 1,
      numPublishers: 1,
      participants: [],
    });
    endRoom.mockResolvedValueOnce(undefined);

    await endCall("mystery-room", ACTOR, "cleanup");

    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: null,
        targetId: "00000000-0000-0000-0000-000000000000",
      }),
    );
  });

  it("reports provider-error and still doesn't throw when endRoom fails", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: NOW,
      numParticipants: 1,
      numPublishers: 1,
      participants: [],
    });
    endRoom.mockRejectedValueOnce(new Error("livekit down"));

    const result = await endCall("class-b1", ACTOR, "stuck");

    expect(result).toEqual({ ok: false, reason: "provider-error" });
    expect(writeOverride).not.toHaveBeenCalled();
  });
});

describe("disconnectCallParticipant", () => {
  it("returns not-found when the participant isn't in the room", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: NOW,
      numParticipants: 1,
      numPublishers: 1,
      participants: [
        {
          identity: "t1",
          name: "Mira",
          sid: "PA_1",
          state: "active",
          joinedAtMs: NOW,
          isPublisher: true,
          tracks: [],
        },
      ],
    });

    const result = await disconnectCallParticipant("class-b1", "ghost", ACTOR, "reason");

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(disconnectParticipant).not.toHaveBeenCalled();
  });

  it("disconnects the participant and audits with their role", async () => {
    getRoomDetail.mockResolvedValueOnce({
      name: "class-b1",
      sid: "RM_1",
      creationTimeMs: NOW,
      numParticipants: 2,
      numPublishers: 2,
      participants: [
        {
          identity: "s1",
          name: "Beto",
          sid: "PA_2",
          state: "active",
          joinedAtMs: NOW,
          isPublisher: true,
          tracks: [],
        },
      ],
    });
    bookingFindMany.mockResolvedValueOnce([
      { id: "b1", teacher: { id: "t1", name: "Mira" }, student: { id: "s1", name: "Beto" } },
    ]);
    disconnectParticipant.mockResolvedValueOnce(undefined);

    const result = await disconnectCallParticipant("class-b1", "s1", ACTOR, "acting out");

    expect(result).toEqual({ ok: true });
    expect(disconnectParticipant).toHaveBeenCalledWith("class-b1", "s1");
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "call",
        targetId: "b1",
        action: "disconnect_participant",
        reason: "acting out",
        before: expect.objectContaining({ identity: "s1", role: "student" }),
      }),
    );
  });
});
