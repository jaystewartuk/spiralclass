"use client";

import { useEffect, useRef, useState } from "react";
import { Track, type Room } from "livekit-client";
import { useT } from "@/components/locale-provider";
import {
  initialMicHealth,
  localMicLevel,
  MIC_SAMPLE_MS,
  sampleMicHealth,
} from "@/lib/video/mic-health";
import { StatusPill } from "./status-pill";

export function MicHealthBanner({
  room,
  enabled,
  remotePresent,
  onEvent,
}: {
  room: Room | null;
  enabled: boolean;
  remotePresent: boolean;
  onEvent: (event: string, props: Record<string, unknown>) => void;
}) {
  return room && enabled && remotePresent ? (
    <MicHealthMonitor room={room} onEvent={onEvent} />
  ) : null;
}

function MicHealthMonitor({
  room,
  onEvent,
}: {
  room: Room;
  onEvent: (event: string, props: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [silent, setSilent] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const eventRef = useRef(onEvent);
  useEffect(() => {
    eventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let state = initialMicHealth();
    let warned = false;
    let currentTrack: MediaStreamTrack | undefined;
    const poll = async () => {
      try {
        const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const track = publication?.audioTrack;
        const media = track?.mediaStreamTrack;
        if (
          !track ||
          !media ||
          publication.isMuted ||
          !media.enabled ||
          media.readyState === "ended"
        ) {
          state = initialMicHealth();
          warned = false;
          if (!cancelled) setSilent(false);
        } else {
          if (media !== currentTrack) {
            currentTrack = media;
            state = initialMicHealth();
          }
          // The sender's source stats describe the published MediaStreamTrack,
          // unlike server speaker levels. No extra capture or AudioContext:
          // mobile autoplay suspension cannot manufacture an all-zero reading.
          const report = await track.getRTCStatsReport();
          if (cancelled || media !== track.mediaStreamTrack) return;
          const level = report && localMicLevel(report, media.id);
          if (level !== undefined) {
            const result = sampleMicHealth(state, {
              level,
              now: performance.now(),
              enabled: true,
              remotePresent: true,
            });
            if (result.status === "silent" && !state.silent) {
              eventRef.current("call_mic_silent", {
                peakLevel: result.state.peakLevel,
                secondsObserved: result.secondsObserved,
                ...(media.label ? { deviceLabel: media.label } : {}),
              });
            }
            // A device replacement also counts as recovery once it carries speech.
            if (result.state.proven) {
              if (warned) eventRef.current("call_mic_silent_recovered", {});
              warned = false;
              setSilent(false);
            } else if (result.status === "silent") {
              warned = true;
              setSilent(true);
            }
            state = result.state;
          }
        }
      } catch {
        // Unsupported/unavailable stats are unknown, not a silent microphone.
      } finally {
        if (!cancelled) timer = setTimeout(poll, MIC_SAMPLE_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [room]);

  if (!silent) return null;
  return (
    <div className="pointer-events-auto flex max-w-md flex-col items-center gap-2">
      <StatusPill
        tone="attention"
        label={t("call.micSilent")}
        onActivate={() => {
          setFailed(false);
          void navigator.mediaDevices
            .enumerateDevices()
            .then((all) => {
              setDevices(all.filter((device) => device.kind === "audioinput"));
            })
            .catch(() => setFailed(true));
        }}
      />
      {devices && (
        <select
          aria-label={t("call.chooseMicrophone")}
          defaultValue=""
          className="max-w-full rounded-md bg-background p-2 text-foreground"
          onChange={(event) => {
            setFailed(false);
            void room
              .switchActiveDevice("audioinput", event.target.value)
              .then(() => setDevices(null))
              .catch(() => setFailed(true));
          }}
        >
          <option value="" disabled>
            {t("call.chooseMicrophone")}
          </option>
          {devices.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || t("call.microphoneNumber", { number: index + 1 })}
            </option>
          ))}
        </select>
      )}
      {failed && <StatusPill tone="warning" label={t("call.microphoneSwitchFailed")} />}
    </div>
  );
}
