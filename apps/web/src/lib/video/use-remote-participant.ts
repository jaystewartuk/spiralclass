"use client";

import { useEffect, useState } from "react";
import { RoomEvent, Track, type Room } from "livekit-client";
import { remoteParticipantView, type RemoteParticipantView } from "@/lib/video/remote-participant";

// The other participant's camera, microphone, speaking and name, kept current
// from the room's own events (remote-participant.ts is the pure half). A
// 1:1 call, so "the other participant" is the first remote one.
const EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.Reconnected,
] as const;

export function useRemoteParticipant(room: Room | null): RemoteParticipantView | null {
  const [view, setView] = useState<RemoteParticipantView | null>(null);

  useEffect(() => {
    if (!room) return;
    const sync = () => {
      const remote = [...room.remoteParticipants.values()][0];
      setView(
        remoteParticipantView(
          remote && {
            identity: remote.identity,
            name: remote.name,
            isSpeaking: remote.isSpeaking,
            getTrackPublication: (source) =>
              remote.getTrackPublication(
                source === "camera" ? Track.Source.Camera : Track.Source.Microphone,
              ),
          },
        ),
      );
    };
    for (const e of EVENTS) room.on(e, sync);
    sync();
    return () => {
      for (const e of EVENTS) room.off(e, sync);
      setView(null);
    };
  }, [room]);

  return view;
}
