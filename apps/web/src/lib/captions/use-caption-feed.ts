"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import {
  CAPTION_TOPIC,
  CAPTIONS_ON_ATTRIBUTE,
  decodeCaption,
  type CaptionLine,
} from "@spiralclass/shared";
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
  // Feed a line this browser recognised itself — the other participant's
  // speech, when their device cannot recognise it (D-185). It joins the same
  // feed a received line does.
  addLine: (line: CaptionLine) => void;
  // Show or hide the band: the room's switch as this browser reads it.
  setActive: (on: boolean) => void;
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
      // Addressed to someone else — see the protocol's note on `for`.
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

  const addLine = useCallback(
    (line: CaptionLine) => dispatch({ kind: "line", line, at: Date.now() }),
    [],
  );
  const setActive = useCallback((on: boolean) => dispatch({ kind: "active", on }), []);

  return { visible, transcript: state.entries, active: state.active, addLine, setActive };
}

// Whether the room's captions switch is currently ON, as seen from either
// side of the call.
//
// The teacher's client writes `captionsOn` as a LiveKit participant
// attribute (D-27), which both browsers read to decide what to recognise
// (use-browser-captions.ts). LiveKit broadcasts attribute changes to every
// participant, so the STUDENT reads the same flag for the band too — without
// it, her only evidence that subtitles existed was a line appearing, one
// recognition plus one translation after the teacher actually flipped the
// switch, and if the teacher then said nothing, her screen stayed
// indistinguishable from a call with no captions at all.
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
    // Any participant with the flag set counts here, for the band alone.
    // What is actually RECOGNISED follows only the teacher's attribute
    // (use-browser-captions.ts), so a student faking her own attribute
    // changes nothing but her own screen's "listening" hint.
    const recompute = () => {
      const local = room.localParticipant?.attributes?.[CAPTIONS_ON_ATTRIBUTE] === "true";
      const remote = [...room.remoteParticipants.values()].some(
        (p) => p.attributes?.[CAPTIONS_ON_ATTRIBUTE] === "true",
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
