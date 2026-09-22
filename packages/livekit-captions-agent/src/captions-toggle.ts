import type { RoomConfig } from "./app-client";

// Pure resolution of "who is allowed to flip the room's captions on/off
// switch, and which identities does that switch cover?" D-27 named this
// feature "teacher-toggled" from the start; a since-undocumented scope
// change (flagged in the 2026-07-25 LIVEKIT_CAPTIONS_AUDIT.md addendum) let
// each side flip its OWN independent toggle, which is what caused both
// directions to sometimes end up racing/flapping against each other. This
// restores the original design: only the teacher's own participant
// attribute is ever trusted as the room's captionsOn signal (see
// room-worker.ts's ParticipantAttributesChanged listener, which now ignores
// attribute changes from anyone else), and that single flag gates BOTH
// directions at once. Per-identity consent (resolveSpeakerDirection in
// direction.ts) still applies on top — the teacher's switch can never make a
// non-consenting student's own speech get transcribed.
//
// Separated from RoomWorker so it's unit-testable without a real LiveKit
// room/track, mirroring direction.ts's own split.

export function isTeacher(roomConfig: RoomConfig, identity: string): boolean {
  return roomConfig.enabled && identity === roomConfig.teacherId;
}

// The two identities the room's single captions switch ever applies to —
// empty when the room isn't enabled at all (feature flag off, Pro gate
// failed, or not a recognized class-call room).
export function captionedIdentities(roomConfig: RoomConfig): string[] {
  return roomConfig.enabled ? [roomConfig.teacherId, roomConfig.studentId] : [];
}
