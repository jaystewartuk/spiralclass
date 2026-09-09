import type { ParticipantConnectionState } from "@spiralclass/shared";

// Domain types for the Live Calls admin dashboard — the layer that joins raw
// LiveKit room/participant data (packages/shared/src/rtc-provider.ts) with
// SpiralClass's own booking/teacher/student rows, so the UI never has to know
// a "room" is really `class-<bookingId>`.

// "unknown" covers a room name that doesn't match our own naming convention
// (lib/video/provider.ts) — shouldn't happen in practice since every room is
// created by our own token-mint flow, but the dashboard must still render
// *something* useful for it rather than crash.
export type CallKind = "class" | "unknown";

export type CallParty = { id: string; name: string } | null;

export type CallParticipantRole = "teacher" | "student" | "unknown";

export type LiveCallSummary = {
  room: string;
  kind: CallKind;
  bookingId: string | null;
  teacher: CallParty;
  student: CallParty;
  numParticipants: number;
  numPublishers: number;
  createdAtMs: number;
  durationSec: number;
  // A class room only ever admits its two named parties. This is true
  // once both have joined at some point — it does NOT dip back to false if
  // one later drops, since LiveKit's numParticipants already reflects who's
  // *currently* connected; "fully connected" here means "at capacity right
  // now" (numParticipants >= 2), the operationally useful reading.
  fullyConnected: boolean;
};

export type LiveCallsDashboard = {
  activeRooms: number;
  activeParticipants: number;
  roomsFullyConnected: number;
  // Rooms where only one of the two expected parties has joined — the
  // single most actionable "something might be wrong" signal available
  // without any extra LiveKit calls (e.g. a student stuck in the waiting
  // room while the teacher never joined, or vice versa).
  roomsWaitingForCounterpart: number;
  avgParticipantsPerRoom: number;
  lastUpdatedMs: number;
};

export type LiveCallsListResult = {
  dashboard: LiveCallsDashboard;
  rooms: LiveCallSummary[];
};

export type LiveCallParticipantDetail = {
  identity: string;
  name: string;
  role: CallParticipantRole;
  state: ParticipantConnectionState;
  joinedAtMs: number;
  durationSec: number;
  isPublisher: boolean;
  audioPublishing: boolean;
  videoPublishing: boolean;
  screenSharing: boolean;
};

export type LiveCallDetail = LiveCallSummary & {
  participants: LiveCallParticipantDetail[];
};

export type LiveCallActionReason = "unavailable" | "not-found" | "provider-error";

export type LiveCallActionResult = { ok: true } | { ok: false; reason: LiveCallActionReason };
