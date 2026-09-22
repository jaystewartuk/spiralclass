import { describe, expect, it } from "vitest";
import { humanIdentities, isJoinCandidate, roomIsIdle } from "./room-lifecycle";
import { AGENT_IDENTITY } from "./config";

describe("humanIdentities", () => {
  it("excludes the Agent's own identity", () => {
    expect(humanIdentities(["t1", AGENT_IDENTITY, "s1"])).toEqual(["t1", "s1"]);
  });

  it("is empty when only the Agent is present", () => {
    expect(humanIdentities([AGENT_IDENTITY])).toEqual([]);
  });
});

describe("roomIsIdle", () => {
  it("is false while a human is still in the room", () => {
    expect(roomIsIdle(["t1"])).toBe(false);
    expect(roomIsIdle(["t1", "s1"], "s1")).toBe(false);
  });

  it("is true once the last human leaves, even though the Agent remains", () => {
    // The Agent is a participant itself, so "the map isn't empty" is never
    // the right test — this is the exact condition that has to hold for
    // LiveKit's empty_timeout to ever reap the room.
    expect(roomIsIdle([AGENT_IDENTITY])).toBe(true);
    expect(roomIsIdle([])).toBe(true);
  });

  it("ignores the participant whose disconnect is being handled", () => {
    // LiveKit may fire ParticipantDisconnected before OR after removing them
    // from the map; both orderings must reach the same answer, or noticing
    // the last leaver comes down to event-ordering luck.
    expect(roomIsIdle(["s1", AGENT_IDENTITY], "s1")).toBe(true);
    expect(roomIsIdle([AGENT_IDENTITY], "s1")).toBe(true);
  });
});

describe("isJoinCandidate", () => {
  it("admits a room that has humans and no worker yet", () => {
    expect(isJoinCandidate({ hasWorker: false, numParticipants: 2 })).toBe(true);
  });

  it("never double-joins a room that already has a worker", () => {
    expect(isJoinCandidate({ hasWorker: true, numParticipants: 2 })).toBe(false);
  });

  it("rejects an outright-empty room without an RPC", () => {
    expect(isJoinCandidate({ hasWorker: false, numParticipants: 0 })).toBe(false);
  });

  it("admits a room whose participant count is unknown", () => {
    // Fail toward captions working rather than toward silence — the
    // confirmation stage decides, not this one.
    expect(isJoinCandidate({ hasWorker: false })).toBe(true);
  });
});

describe("the join decision is two-stage", () => {
  // Regression guard for the 2026-07-29 rejoin race. A worker left an idle
  // room correctly; 873ms later Discovery rejoined it because listRooms()
  // still counted the Agent's own departed session. Back in an empty room,
  // no ParticipantDisconnected could ever fire, so roomIsIdle was never
  // re-evaluated and the worker held the room open indefinitely — the exact
  // deadlock the leave logic exists to break.
  it("cannot be settled by the participant count alone", () => {
    // What listRooms() reports moments after the Agent leaves. Identical to
    // a room holding exactly one human — the count does not say WHO.
    expect(isJoinCandidate({ hasWorker: false, numParticipants: 1 })).toBe(true);

    // Identities settle it, because roomIsIdle subtracts the Agent by name.
    expect(roomIsIdle([AGENT_IDENTITY])).toBe(true); // stale count, nobody home
    expect(roomIsIdle(["s1"])).toBe(false); // genuinely one human
  });

  it("still joins a room holding one human besides the Agent", () => {
    // The stale-count fix must not cost captions on a real one-person room
    // (a teacher waiting for a student who hasn't joined yet).
    expect(isJoinCandidate({ hasWorker: false, numParticipants: 2 })).toBe(true);
    expect(roomIsIdle(["t1", AGENT_IDENTITY])).toBe(false);
  });
});
