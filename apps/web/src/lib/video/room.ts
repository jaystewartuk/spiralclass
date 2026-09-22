import { getVideoProvider } from "@/lib/video/providers";

// Server-side room introspection for the lesson-insights audio capture
// and the in-class
// nudge (lib/video/nudge.ts). Phase A's per-participant audio egress needs
// each participant's microphone *track* SID, which only the active provider
// can resolve mid-call — the join token carries an identity, not a track id.
//
// As of docs/features/live-calls-video.md, this
// routes through the active VideoProvider instead of constructing a LiveKit
// RoomServiceClient directly — the same two exported functions, unchanged
// signatures, so lib/video/lesson-audio.ts and lib/video/nudge.ts needed no
// changes at all.

export type ParticipantMicTrack = { identity: string; trackId: string };

// One published microphone track per participant, with the stable identity the
// join grant minted (the teacher/student user id — see lib/video/provider.ts).
// Participants without a published, unmuted mic track are skipped — there's no
// audio to capture for them. Returns [] when no provider is configured.
export async function listParticipantMicTracks(room: string): Promise<ParticipantMicTrack[]> {
  const provider = getVideoProvider();
  if (!provider) return [];

  const participants = await provider.listParticipants(room);
  const tracks: ParticipantMicTrack[] = [];
  for (const p of participants) {
    if (!p.micTrackId) continue;
    tracks.push({ identity: p.identity, trackId: p.micTrackId });
  }
  return tracks;
}

// The stable identities (teacher/student user ids — see lib/video/provider.ts)
// of everyone currently connected to a room. Used by the in-class nudge
// (lib/video/nudge.ts) as a race guard: if the counterparty is already here,
// there's no one to nudge. Returns [] when no provider is configured — the
// caller treats "can't tell" as "nobody's here" and proceeds (the redundant
// push is harmless and the cooldown bounds it).
export async function listRoomParticipantIdentities(room: string): Promise<string[]> {
  const provider = getVideoProvider();
  if (!provider) return [];

  // A room with no participants throws/404s on some LiveKit versions; treat
  // any introspection failure as "empty" rather than blocking the nudge.
  try {
    const participants = await provider.listParticipants(room);
    return participants.map((p) => p.identity);
  } catch {
    return [];
  }
}
