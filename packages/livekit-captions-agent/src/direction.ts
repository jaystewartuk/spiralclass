import type { RoomConfig } from "./app-client";

export type SpeakerDirection = { source: string; target: string; listenerIdentity: string };

// Pure resolution of "given this room's config and who's speaking, what
// language direction should their speech be transcribed/translated in, and
// who should the translated line be addressed to?" Separated from
// RoomWorker so it's unit-testable without a real LiveKit room/track.
// Returns null when the speaker isn't a recognized party of this booking, or
// when the speaker is the student and she hasn't consented — either way,
// nothing should be transcribed for them.
export function resolveSpeakerDirection(
  roomConfig: RoomConfig,
  speakerIdentity: string,
): SpeakerDirection | null {
  if (!roomConfig.enabled) return null;
  const { teacherId, studentId, teacherDirection, studentDirection, studentCaptionsAllowed } =
    roomConfig;
  if (speakerIdentity === teacherId) {
    return { ...teacherDirection, listenerIdentity: studentId };
  }
  if (speakerIdentity === studentId) {
    if (!studentCaptionsAllowed) return null;
    return { ...studentDirection, listenerIdentity: teacherId };
  }
  return null;
}
