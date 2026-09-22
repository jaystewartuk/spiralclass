import { prisma } from "@/lib/prisma";
import { getVideoProvider } from "@/lib/video/providers";
import { bookingIdFromCallRoom } from "@/lib/video/provider";
import { writeOverride } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { AdminActor } from "@/lib/admin";
import type {
  CallKind,
  CallParticipantRole,
  CallParty,
  LiveCallActionResult,
  LiveCallDetail,
  LiveCallParticipantDetail,
  LiveCallsDashboard,
  LiveCallsListResult,
  LiveCallSummary,
} from "./types";

const log = logger({ surface: "live-calls" });

// Sentinel used for Override.targetId (a required @db.Uuid) when a room's
// name doesn't resolve to a real booking id — see the "unknown" CallKind
// comment in types.ts. Mirrors lib/admin.ts's BOOTSTRAP_ACTOR_ID
// convention: a real column value, never a NULL, so the row still audits.
const UNRESOLVED_TARGET_ID = "00000000-0000-0000-0000-000000000000";

function classify(room: string): { kind: CallKind; bookingId: string | null } {
  const bookingId = bookingIdFromCallRoom(room);
  return bookingId ? { kind: "class", bookingId } : { kind: "unknown", bookingId: null };
}

type CallContext = {
  kind: CallKind;
  bookingId: string | null;
  teacher: CallParty;
  student: CallParty;
};

const EMPTY_CONTEXT: CallContext = {
  kind: "unknown",
  bookingId: null,
  teacher: null,
  student: null,
};

// Batches the DB side of "who is this room for" across every room in one
// shot — a single query for all bookings, no matter how many rooms are live.
// Works for one room (the detail view) or many (the list view) with the same
// code path.
async function resolveCallContexts(roomNames: string[]): Promise<Map<string, CallContext>> {
  const classified = new Map(roomNames.map((name) => [name, classify(name)]));
  const bookingIds = [...classified.values()].flatMap((c) => (c.bookingId ? [c.bookingId] : []));

  const bookings = bookingIds.length
    ? await prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: {
          id: true,
          teacher: { select: { id: true, name: true } },
          student: { select: { id: true, name: true } },
        },
      })
    : [];

  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  const result = new Map<string, CallContext>();
  for (const [room, c] of classified) {
    const booking = c.bookingId ? bookingById.get(c.bookingId) : undefined;
    result.set(room, {
      ...c,
      teacher: booking?.teacher ?? null,
      student: booking?.student ?? null,
    });
  }
  return result;
}

function contextFor(map: Map<string, CallContext>, room: string): CallContext {
  return map.get(room) ?? EMPTY_CONTEXT;
}

function roleFor(identity: string, teacher: CallParty, student: CallParty): CallParticipantRole {
  if (teacher && identity === teacher.id) return "teacher";
  if (student && identity === student.id) return "student";
  return "unknown";
}

function targetIdFor(ctx: CallContext): string {
  return ctx.bookingId ?? UNRESOLVED_TARGET_ID;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The Live Calls dashboard's primary read. Exactly one LiveKit API call
// (listRooms) no matter how many rooms are active — room-level counts only,
// no per-room participant fetch, so this stays cheap at any scale. Returns
// null when no video provider is configured (dev, or prod before LiveKit
// credentials are set) so the page can render a distinct "not configured"
// empty state instead of confusing it with "zero active calls".
export async function listActiveCalls(nowMs: number): Promise<LiveCallsListResult | null> {
  const provider = getVideoProvider();
  if (!provider) return null;

  const rooms = await provider.listActiveRooms();
  const contexts = await resolveCallContexts(rooms.map((r) => r.name));

  const summaries: LiveCallSummary[] = rooms.map((room) => {
    const ctx = contextFor(contexts, room.name);
    return {
      room: room.name,
      kind: ctx.kind,
      bookingId: ctx.bookingId,
      teacher: ctx.teacher,
      student: ctx.student,
      numParticipants: room.numParticipants,
      numPublishers: room.numPublishers,
      createdAtMs: room.creationTimeMs,
      durationSec: Math.max(0, Math.round((nowMs - room.creationTimeMs) / 1000)),
      fullyConnected: room.numParticipants >= 2,
    };
  });

  const activeParticipants = summaries.reduce((sum, r) => sum + r.numParticipants, 0);
  const roomsFullyConnected = summaries.filter((r) => r.fullyConnected).length;

  const dashboard: LiveCallsDashboard = {
    activeRooms: summaries.length,
    activeParticipants,
    roomsFullyConnected,
    roomsWaitingForCounterpart: summaries.length - roomsFullyConnected,
    avgParticipantsPerRoom: summaries.length ? round1(activeParticipants / summaries.length) : 0,
    lastUpdatedMs: nowMs,
  };

  return { dashboard, rooms: summaries };
}

// Full per-participant detail for one room — the expensive call
// (listParticipants + every track) that the list view deliberately defers
// until an admin actually opens a room, per the lazy-load design.
export async function getCallDetail(room: string, nowMs: number): Promise<LiveCallDetail | null> {
  const provider = getVideoProvider();
  if (!provider) return null;

  const detail = await provider.getRoomDetail(room);
  if (!detail) return null;

  const ctx = contextFor(await resolveCallContexts([room]), room);

  const participants: LiveCallParticipantDetail[] = detail.participants.map((p) => ({
    identity: p.identity,
    name: p.name,
    role: roleFor(p.identity, ctx.teacher, ctx.student),
    state: p.state,
    joinedAtMs: p.joinedAtMs,
    durationSec: Math.max(0, Math.round((nowMs - p.joinedAtMs) / 1000)),
    isPublisher: p.isPublisher,
    audioPublishing: p.tracks.some((t) => t.kind === "audio" && !t.muted),
    videoPublishing: p.tracks.some((t) => t.kind === "video" && !t.muted),
    screenSharing: p.tracks.some(
      (t) => (t.kind === "screen_share" || t.kind === "screen_share_audio") && !t.muted,
    ),
  }));

  return {
    room,
    kind: ctx.kind,
    bookingId: ctx.bookingId,
    teacher: ctx.teacher,
    student: ctx.student,
    numParticipants: detail.numParticipants,
    numPublishers: detail.numPublishers,
    createdAtMs: detail.creationTimeMs,
    durationSec: Math.max(0, Math.round((nowMs - detail.creationTimeMs) / 1000)),
    fullyConnected: detail.numParticipants >= 2,
    participants,
  };
}

// Force-ends a room (disconnects everyone). Always audited via the existing
// `overrides` trail (targetType "call") regardless of outcome being
// resolvable to a booking, so nothing an admin does here goes
// unaudited.
export async function endCall(
  room: string,
  actor: AdminActor,
  reason: string,
): Promise<LiveCallActionResult> {
  const provider = getVideoProvider();
  if (!provider) return { ok: false, reason: "unavailable" };

  const contextsPromise = resolveCallContexts([room]);
  const before = await provider.getRoomDetail(room);
  if (!before) return { ok: false, reason: "not-found" };
  const ctx = contextFor(await contextsPromise, room);

  try {
    await provider.endRoom(room);
  } catch (err) {
    log.error("failed to end room", err, { room });
    return { ok: false, reason: "provider-error" };
  }

  await writeOverride({
    teacherId: ctx.teacher?.id ?? null,
    targetType: "call",
    targetId: targetIdFor(ctx),
    action: "end_call",
    reason,
    before: {
      room,
      kind: ctx.kind,
      numParticipants: before.numParticipants,
      participantIdentities: before.participants.map((p) => p.identity),
    },
    after: null,
    actor,
  });

  return { ok: true };
}

// Force-disconnects a single participant; the room stays open for whoever
// else is in it.
export async function disconnectCallParticipant(
  room: string,
  identity: string,
  actor: AdminActor,
  reason: string,
): Promise<LiveCallActionResult> {
  const provider = getVideoProvider();
  if (!provider) return { ok: false, reason: "unavailable" };

  const contextsPromise = resolveCallContexts([room]);
  const before = await provider.getRoomDetail(room);
  const participant = before?.participants.find((p) => p.identity === identity);
  if (!before || !participant) return { ok: false, reason: "not-found" };
  const ctx = contextFor(await contextsPromise, room);

  try {
    await provider.disconnectParticipant(room, identity);
  } catch (err) {
    log.error("failed to disconnect participant", err, { room, identity });
    return { ok: false, reason: "provider-error" };
  }

  await writeOverride({
    teacherId: ctx.teacher?.id ?? null,
    targetType: "call",
    targetId: targetIdFor(ctx),
    action: "disconnect_participant",
    reason,
    before: {
      room,
      identity,
      name: participant.name,
      role: roleFor(identity, ctx.teacher, ctx.student),
    },
    after: null,
    actor,
  });

  return { ok: true };
}
