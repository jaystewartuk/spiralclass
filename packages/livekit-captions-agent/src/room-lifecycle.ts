import { AGENT_IDENTITY } from "./config";

// Pure room-lifecycle decisions: "does this room still need a worker?" and
// "should Discovery join this room at all?". Separated from RoomWorker /
// Discovery so the branching is unit-testable without a real LiveKit room,
// mirroring direction.ts's and captions-toggle.ts's own split.
//
// The two answers are load-bearing TOGETHER, not independently. The Agent
// joins each room as a real LiveKit participant, so its own presence is what
// keeps a room from ever being "empty" — and LiveKit's empty_timeout (the
// 5-minute default; the app never calls createRoom, so rooms auto-create with
// it) only reaps a room once the last participant leaves. Discovery, in turn,
// only stopped a worker once the room vanished from listRooms(). That is a
// deadlock: the room can't close while the Agent sits in it, and the Agent
// wouldn't leave until the room closed.
//
// Observed in production 2026-07-28: two rooms whose calls had ended long
// before still held live workers polling roomConfig every 60s, and the leak
// grew by one worker per class until the container restarted. It also made
// the stale-`micHandledForIdentity` bug reachable — a worker that outlives
// its call carries per-identity state into the next one. Leaving when the
// humans leave is what lets empty_timeout do its job.

// The room's human participants — everyone who isn't the Agent itself.
export function humanIdentities(identities: Iterable<string>): string[] {
  return [...identities].filter((identity) => identity !== AGENT_IDENTITY);
}

// Whether the worker should leave: no human participants remain.
//
// `leaving` is the identity of a participant whose disconnect is being
// handled right now. LiveKit may or may not have already removed them from
// the room's participant map by the time the event fires, so it's excluded
// explicitly rather than trusted to be gone — otherwise whether the last
// participant leaving is noticed at all depends on event-ordering luck.
export function roomIsIdle(remoteIdentities: Iterable<string>, leaving?: string): boolean {
  return humanIdentities(remoteIdentities).filter((identity) => identity !== leaving).length === 0;
}

// FIRST of two stages in the join decision: a free pre-filter over what
// listRooms() already told us, so the common cases cost no extra RPC.
//
// It is deliberately NOT the final word. The original version of this
// function assumed "a room we are NOT already in has no Agent participant, so
// every participant it reports is a human". That assumption breaks in exactly
// the case that matters: for a second or so after a worker leaves an idle
// room, the server still counts the Agent's own departed session, so
// numParticipants reads 1 when the truth is zero humans. Discovery rejoined on
// that stale count 873ms after leaving (production, 2026-07-29), landing back
// in an empty room with no human left to ever fire ParticipantDisconnected —
// so roomIsIdle was never re-evaluated and the worker sat there forever. Same
// deadlock the leave logic was added to break, reached one cycle later.
//
// A bare count cannot distinguish "one human" from "only us, still counted",
// because it does not say WHO. Confirm a candidate against real identities
// (roomIsIdle over listParticipants) before joining — that predicate subtracts
// the Agent by name, so it is correct whether or not the count has settled,
// and it is the same predicate the worker uses to decide to leave. Join and
// leave cannot disagree about what "empty" means.
//
// numParticipants is undefined only if the server omitted the field; treat
// that as "unknown, let the confirmation stage decide" rather than skipping,
// so a missing field degrades toward captions working rather than silence.
export function isJoinCandidate(opts: { hasWorker: boolean; numParticipants?: number }): boolean {
  if (opts.hasWorker) return false;
  if (opts.numParticipants === undefined) return true;
  return opts.numParticipants > 0;
}
