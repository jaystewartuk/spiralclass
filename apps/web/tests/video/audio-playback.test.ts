import { describe, it, expect, vi } from "vitest";

import { guardAudioPlaybackResume } from "@/lib/video/audio-playback";

// Regression guard for AGENDAPROFE-3J: "AbortError: The operation was aborted.",
// unhandled, no stack, on /dashboard/classes/:bookingId/call. The teacher had a
// class open on her iPhone (iOS 18.7.8, Chrome iOS) for thirty-one minutes;
// coming back to the tab fires livekit-client's own visibility retry of
// `room.startAudio()`, which re-throws the rejected `play()` into a promise
// nobody holds. The library's recovery attempt, reported to us as a crash.
//
// These tests pin the two properties that fix costs nothing: the rejection
// cannot escape, and the resume still actually runs.
describe("guardAudioPlaybackResume", () => {
  // WebKit's message for an aborted media play(), verbatim from the event.
  const abort = () =>
    Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

  it("swallows the rejection livekit-client re-throws from its own retries", async () => {
    const room = guardAudioPlaybackResume({ startAudio: () => Promise.reject(abort()) });
    // The library calls this and drops the promise on the floor. If it can
    // reject, the browser's refusal is an unhandled rejection in production.
    await expect(room.startAudio()).resolves.toBeUndefined();
  });

  it("still calls through, so audio actually resumes when the browser allows it", async () => {
    const startAudio = vi.fn(() => Promise.resolve());
    const room = guardAudioPlaybackResume({ startAudio });

    await room.startAudio();

    expect(startAudio).toHaveBeenCalledTimes(1);
  });

  it("keeps `this` bound to the room livekit calls it on", async () => {
    // livekit's visibility handler calls `this.startAudio()` off the instance,
    // but its AudioStreamAcquired listener holds a bare reference to whatever
    // the property was at connect time — so the wrapper must not depend on how
    // it is invoked.
    const room = guardAudioPlaybackResume({
      unblocked: false,
      startAudio() {
        this.unblocked = true;
        return Promise.resolve();
      },
    });

    const detached = room.startAudio;
    await detached();

    expect(room.unblocked).toBe(true);
  });

  it("returns the same room, so it can wrap the constructor call", () => {
    const room = { startAudio: () => Promise.resolve() };
    expect(guardAudioPlaybackResume(room)).toBe(room);
  });
});
