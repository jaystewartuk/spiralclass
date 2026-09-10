// Blocked call audio: whose failure it is, and how it is allowed to surface.
//
// A browser will not play a remote participant's <audio> element until the page
// has earned the right to make sound. iOS is the strict case: it refuses unless
// the user is publishing audio herself or something is already playing. So
// livekit-client retries the unblock for us — it calls `room.startAudio()` when
// the local microphone track is acquired (ParticipantEvent.AudioStreamAcquired)
// and again every time the page becomes visible after being hidden.
//
// Neither of those internal calls is awaited or caught, and `startAudio()`
// re-throws whatever `HTMLMediaElement.play()` rejected with (livekit-client
// 2.22.2, `Room.startAudio`). On WebKit a play() that loses a race rejects with
// `AbortError: The operation was aborted.` — so the library's own recovery
// attempt escapes the app as an unhandled promise rejection, with no stack,
// from no line of ours.
//
// That is the whole of AGENDAPROFE-3J: a teacher left a class open on an
// iPhone, came back to the tab thirty-one minutes later, and a browser
// declining to make noise was reported as an application crash.
//
// Swallowing it loses no information, because the failure already has a
// first-class channel: a failed `startAudio()` leaves `room.canPlaybackAudio`
// false and emits RoomEvent.AudioPlaybackStatusChanged, which is what the call
// surface's "tap to turn the sound on" row is driven by. The rejection was
// never the signal — the room state is, and unlike the rejection it says
// something the user can act on.
//
// This does NOT paper over silent audio; it is what makes silent audio
// visible, by moving the app off a rejection it cannot act on and onto the
// state it can.

// Structural, not `Room`: the guard needs one method, and typing it this way is
// what lets the behaviour be tested without a browser, a media server or a
// WebRTC stack — the same reason call-connection.ts never mentions Room either.
type ResumesAudioPlayback = { startAudio: () => Promise<void> };

/**
 * Make livekit-client's own audio-unblock retries unable to escape as unhandled
 * promise rejections. Returns the same room, for call-site brevity.
 *
 * ⚠️ Install this BEFORE `room.connect()`. livekit registers its
 * `AudioStreamAcquired → startAudio` listener during connect, capturing
 * whatever `room.startAudio` is at that moment; replacing the property first is
 * what routes BOTH of its internal call sites through this one. Installed
 * afterwards it would guard the visibility-change retry and miss the other.
 */
export function guardAudioPlaybackResume<T extends ResumesAudioPlayback>(room: T): T {
  const resume = room.startAudio.bind(room);
  room.startAudio = () =>
    resume().catch(() => {
      // Deliberately silent. See above: AudioPlaybackStatusChanged +
      // canPlaybackAudio are the reportable state, and the call UI listens to
      // them. Re-reporting here would only restore the crash-shaped noise.
    });
  return room;
}
