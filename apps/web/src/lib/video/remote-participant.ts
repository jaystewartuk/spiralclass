// What the call screen shows about the OTHER person when their video cannot
// say it: whether their camera and microphone are on, whether they are
// speaking, and what to call them. A student with the camera off used to be a
// black stage — no name, no sign that anyone was there, no way to tell a
// muted microphone from a silent one.
//
// Pure, over the few participant fields it reads, so it is testable without
// livekit-client's runtime; use-remote-participant.ts feeds it.

export type ParticipantLike = {
  identity: string;
  name?: string;
  isSpeaking: boolean;
  getTrackPublication(
    source: "camera" | "microphone",
  ): { isMuted: boolean; isSubscribed?: boolean; track?: unknown } | undefined;
};

export type RemoteParticipantView = {
  identity: string;
  name: string | null;
  initials: string;
  camOn: boolean;
  micOn: boolean;
  // Only while the microphone is on — a muted participant is never "speaking".
  speaking: boolean;
};

export function remoteParticipantView(
  p: ParticipantLike | undefined,
): RemoteParticipantView | null {
  if (!p) return null;
  const cam = p.getTrackPublication("camera");
  const mic = p.getTrackPublication("microphone");
  // A camera counts as on only when a frame can actually arrive here: a
  // publication that is muted, or not yet subscribed, draws nothing.
  const camOn = Boolean(cam && !cam.isMuted && cam.track);
  const micOn = Boolean(mic && !mic.isMuted);
  const name = p.name?.trim() || null;
  return {
    identity: p.identity,
    name,
    initials: initialsOf(name),
    camOn,
    micOn,
    speaking: micOn && p.isSpeaking,
  };
}

// Up to two initials, from the first and last words — "María José Hernández"
// is "MH", "Farid" is "F". A missing name is "?" rather than an identity's
// first letter, which would be a UUID's.
export function initialsOf(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toLocaleUpperCase();
}
