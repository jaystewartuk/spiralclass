"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  baseLanguage,
  CAPTION_TOPIC,
  CAPTIONS_ON_ATTRIBUTE,
  CAPTIONS_RECOGNIZER_ATTRIBUTE,
  encodeCaption,
  type CallRole,
  type CaptionLine,
  type CaptionSession,
} from "@spiralclass/shared";
import {
  BrowserCaptions,
  type BrowserCaptionsStatus,
  type CaptionRoomView,
} from "@/lib/captions/browser-captions";
import {
  browserCanRecognizeDuringCall,
  speechRecognitionCtor,
  translatorApi,
} from "@/lib/captions/recognition-environment";
import { installOnDeviceModels } from "@/lib/captions/recognizer";

// React + LiveKit wiring for live captions in the browser (D-185). Everything
// that decides anything lives in browser-captions.ts; this hook only reads
// the room into plain values, fetches the class's caption session, and hands
// both to it.
//
//   * It publishes this browser's CAPTIONS_RECOGNIZER_ATTRIBUTE once the room
//     connects, so the other participant's browser can run the same
//     assignment of who recognises whom.
//   * It reads the room switch: the teacher's own toggle on her side; her
//     CAPTIONS_ON_ATTRIBUTE on the student's — and only hers, once the
//     session names her.
//   * It fetches POST /api/captions/config when the switch turns on (and, for
//     the teacher, as soon as the call connects, so her toggle click has the
//     languages it needs to start the on-device downloads), then re-reads it
//     every minute while captions stay on: a consent revoked, a language
//     changed or a plan downgraded mid-class reaches both browsers within a
//     poll — the live re-check the retired captions agent's own config poll
//     gave (D-106), kept when captions moved into the browser (D-185).

export const CONFIG_POLL_MS = 60_000;

const INITIAL_STATUS: BrowserCaptionsStatus = { uncaptioned: [], stopped: null };

export function useBrowserCaptions({
  room,
  bookingId,
  role,
  teacherCaptionsOn,
  prefetchSession,
  showLocal,
}: {
  room: Room | null;
  bookingId: string | undefined;
  role: CallRole | undefined;
  // The teacher's own toggle state. Ignored on the student's side, which
  // reads the teacher's attribute instead.
  teacherCaptionsOn: boolean;
  // The teacher's call page, when it can show the toggle: fetch the session
  // at connect rather than at the first toggle.
  prefetchSession: boolean;
  // Render a line this browser recognised for its own viewer.
  showLocal: (line: CaptionLine) => void;
}): {
  // The room's switch as this browser sees it.
  captionsOn: boolean;
  status: BrowserCaptionsStatus;
  // 0..1 while an on-device translation model downloads, else null.
  downloadProgress: number | null;
  // Call synchronously inside the teacher's toggle click (see
  // installOnDeviceModels for why it cannot wait).
  prepareOnDevice: () => void;
} {
  const selfCapable = useMemo(
    () => typeof window !== "undefined" && browserCanRecognizeDuringCall(window),
    [],
  );
  const [session, setSession] = useState<CaptionSession | null>(null);
  const sessionRef = useRef<CaptionSession | null>(null);
  const [status, setStatus] = useState<BrowserCaptionsStatus>(INITIAL_STATUS);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [roomVersion, setRoomVersion] = useState(0);
  const [refetchKey, setRefetchKey] = useState(0);
  const showLocalRef = useRef(showLocal);
  // Latest values for callbacks that must stay stable: the toggle click reads
  // the session, the controller hands lines to whatever showLocal is now.
  useEffect(() => {
    sessionRef.current = session;
    showLocalRef.current = showLocal;
  }, [session, showLocal]);

  // Every room event that can change who is here, what they publish, or
  // what their attributes say.
  useEffect(() => {
    if (!room) return;
    const bump = () => setRoomVersion((v) => v + 1);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.Reconnected,
    ] as const;
    for (const e of events) room.on(e, bump);
    bump();
    void room.localParticipant
      .setAttributes({ [CAPTIONS_RECOGNIZER_ATTRIBUTE]: selfCapable ? "1" : "0" })
      .catch(() => {
        // Without the attribute the other side reads this browser as unable
        // to recognise, and does the work itself when it can — a safe default.
      });
    return () => {
      for (const e of events) room.off(e, bump);
    };
  }, [room, selfCapable]);

  const view = useMemo((): CaptionRoomView | null => {
    if (!room) return null;
    const remote = [...room.remoteParticipants.values()][0];
    return {
      localIdentity: room.localParticipant.identity,
      localMicTrack:
        room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
          ?.mediaStreamTrack ?? null,
      remote: remote
        ? {
            identity: remote.identity,
            micTrack:
              remote.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null,
            capable: remote.attributes?.[CAPTIONS_RECOGNIZER_ATTRIBUTE] === "1",
          }
        : null,
    };
    // roomVersion is the signal that the room object mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, roomVersion]);

  const captionsOn = useMemo(() => {
    if (role === "teacher") return teacherCaptionsOn;
    if (!room) return false;
    // Only the teacher's switch counts (D-27). Until the session names her,
    // any other participant's flag is enough to go and ask the server — which
    // is what then names her.
    const teacherIdentity = session?.teacherIdentity;
    return [...room.remoteParticipants.values()].some(
      (p) =>
        (!teacherIdentity || p.identity === teacherIdentity) &&
        p.attributes?.[CAPTIONS_ON_ATTRIBUTE] === "true",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, teacherCaptionsOn, room, roomVersion, session]);

  // The class's caption session: fetched when needed, re-read every minute
  // while captions are on, and re-read at once after a refusal.
  const wantSession = Boolean(room && bookingId && (captionsOn || prefetchSession));
  useEffect(() => {
    if (!wantSession || !bookingId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/captions/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookingId }),
        });
        const body = (await res.json().catch(() => null)) as {
          enabled?: boolean;
          session?: CaptionSession;
        } | null;
        if (cancelled) return;
        if (res.ok) setSession(body?.enabled && body.session ? body.session : null);
        // A failed read keeps the last session: a blip must not stop captions.
      } catch {
        // Same: keep what we had.
      }
    };
    void load();
    const timer = captionsOn ? setInterval(load, CONFIG_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [wantSession, bookingId, captionsOn, refetchKey]);

  // One controller per room.
  const controllerRef = useRef<BrowserCaptions | null>(null);
  useEffect(() => {
    if (!room) return;
    const controller = new BrowserCaptions({
      SpeechRecognition: speechRecognitionCtor(window),
      Translator: translatorApi(window),
      fetch: (input, init) => fetch(input, init),
      publish: async (line) => {
        await room.localParticipant.publishData(encodeCaption(line), {
          reliable: true,
          topic: CAPTION_TOPIC,
          // Addressed twice on purpose: `line.for` is what the receiver
          // checks, and this keeps the packet off anyone else's wire.
          destinationIdentities: [line.for],
        });
      },
      showLocal: (line) => showLocalRef.current(line),
      onStatus: setStatus,
      onRefused: () => setRefetchKey((k) => k + 1),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
      setStatus(INITIAL_STATUS);
    };
  }, [room]);

  useEffect(() => {
    if (!view) return;
    controllerRef.current?.sync({ session, captionsOn, selfCapable, room: view });
  }, [session, captionsOn, selfCapable, view]);

  const prepareOnDevice = useCallback(() => {
    const s = sessionRef.current;
    if (!s || typeof window === "undefined") return;
    installOnDeviceModels({
      SpeechRecognition: speechRecognitionCtor(window),
      Translator: translatorApi(window),
      // Both speakers: this browser may end up recognising the other person
      // too, when their device cannot. The student's only with her consent.
      recognitionLangs: [
        s.recognitionLocales.teacher,
        ...(s.studentConsent ? [s.recognitionLocales.student] : []),
      ],
      translatorPairs: (s.studentConsent
        ? (["teacher", "student"] as const)
        : (["teacher"] as const)
      ).map((speaker) => ({
        sourceLanguage: baseLanguage(s.directions[speaker].source),
        targetLanguage: baseLanguage(s.directions[speaker].target),
      })),
      onTranslatorProgress: (loaded) => setDownloadProgress(loaded < 1 ? loaded : null),
    });
  }, []);

  return { captionsOn, status, downloadProgress, prepareOnDevice };
}
