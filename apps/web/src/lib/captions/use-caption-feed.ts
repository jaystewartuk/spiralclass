"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { CAPTION_TOPIC, decodeCaption } from "@spiralclass/shared";
import {
  INITIAL_FEED_STATE,
  reduceCaptionFeed,
  nextExpiryAt,
  visibleCaptions,
  type CaptionEntry,
  type CaptionFeedState,
} from "./caption-feed";

// React wiring for the caption feed. Subscribes to the room's caption topic,
// folds every packet through the pure reducer in caption-feed.ts, and hands
// the view both the live band window and the whole transcript.
//
// Supersedes useCaptionReceiver + useCaptionTicker, which between them kept
// exactly one line of state and a linger timer. Two things are structurally
// different here:
//
//   * The reducer keeps EVERY line, so the transcript exists at all. The
//     band is a derived window over it rather than the only thing retained.
//   * Expiry is one timer armed for the next real expiry, not a repeating
//     tick. The old design re-armed a 6s timeout per line and cleared the
//     whole band; this arms at most one timeout at a time and only when a
//     line is genuinely still on screen, so an idle call re-renders never.

export type CaptionFeed = {
  // The lines currently on screen, oldest first.
  visible: CaptionEntry[];
  // Everything said this call, oldest first — the transcript panel's source.
  transcript: CaptionEntry[];
  // Whether the room is captioning right now (the teacher's switch).
  active: boolean;
};

export function useCaptionFeed(room: Room | null): CaptionFeed {
  const [state, dispatch] = useReducer(reduceCaptionFeed, INITIAL_FEED_STATE);
  // Bumped whenever the visible window may have changed for a reason other
  // than a new packet — i.e. a line aged out. Cheaper and clearer than
  // storing a clock in the reducer, which would make it impure.
  const [expiryTick, setExpiryTick] = useState(0);

  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic !== CAPTION_TOPIC) return;
      const msg = decodeCaption(payload);
      if (!msg) return;
      // Addressed to someone else. The captions Agent is a THIRD room
      // participant, so "arrived on this topic" has not implied "meant for
      // me" since it shipped.
      if (msg.for !== room.localParticipant?.identity) return;
      if (msg.t === "state") {
        dispatch({ kind: "active", on: msg.on });
        return;
      }
      dispatch({ kind: "line", line: msg, at: Date.now() });
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  // Leaving the room ends the session the transcript belongs to. Nothing
  // persists it anywhere, which is exactly what the privacy notice promises.
  useEffect(() => {
    if (room) return;
    dispatch({ kind: "active", on: false });
  }, [room]);

  const visible = useMemo(
    () => visibleCaptions(state, Date.now()),
    // expiryTick is a deliberate dependency: it is the signal that a line
    // aged out, and without it the memo would hold a stale window until the
    // next packet arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, expiryTick],
  );

  // One timer, armed for the next line that will actually expire.
  useEffect(() => {
    const at = nextExpiryAt(state, Date.now());
    if (at == null) return;
    const delay = Math.max(0, at - Date.now());
    const timer = setTimeout(() => setExpiryTick((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [state, expiryTick]);

  return { visible, transcript: state.entries, active: state.active };
}

// Whether the room's captions switch is currently ON, as seen from either
// side of the call.
//
// The teacher's client writes `captionsOn` as a LiveKit participant
// attribute (D-27) and the Agent reads it. LiveKit broadcasts attribute
// changes to every participant, so the STUDENT can read the same flag — and
// until now did not: her only evidence that subtitles existed was a line
// appearing, which is one ASR round-trip plus one translation after the
// teacher actually flipped the switch. For those seconds her screen was
// indistinguishable from a call with no captions at all, and if the teacher
// then said nothing, it stayed that way.
//
// Reading the attribute directly closes that gap and is what lets the band
// show a "listening" state instead of nothing.
export function useRoomCaptionsEnabled(room: Room | null): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!room) {
      setOn(false);
      return;
    }
    // Any participant with the flag set counts. Only the teacher's is ever
    // trusted server-side (the Agent checks isTeacher before acting on it),
    // so a student faking her own attribute changes nothing but her own
    // screen's "listening" hint — the audio gate is not here.
    const recompute = () => {
      const local = room.localParticipant?.attributes?.captionsOn === "true";
      const remote = [...room.remoteParticipants.values()].some(
        (p) => p.attributes?.captionsOn === "true",
      );
      setOn(local || remote);
    };
    recompute();
    room
      .on(RoomEvent.ParticipantAttributesChanged, recompute)
      .on(RoomEvent.LocalTrackPublished, recompute)
      .on(RoomEvent.ParticipantConnected, recompute)
      .on(RoomEvent.ParticipantDisconnected, recompute);
    return () => {
      room
        .off(RoomEvent.ParticipantAttributesChanged, recompute)
        .off(RoomEvent.LocalTrackPublished, recompute)
        .off(RoomEvent.ParticipantConnected, recompute)
        .off(RoomEvent.ParticipantDisconnected, recompute);
    };
  }, [room]);

  return on;
}

export type { CaptionEntry, CaptionFeedState };
