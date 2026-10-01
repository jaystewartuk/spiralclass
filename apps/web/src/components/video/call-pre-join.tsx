"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import {
  devicesOfKind,
  levelFromTimeDomain,
  mediaProblemOf,
  type DeviceLike,
  type MediaProblem,
} from "@/lib/video/pre-join";
import { CallTopBar } from "./call-top-bar";

export type JoinChoice = {
  mic: boolean;
  cam: boolean;
  micDeviceId?: string;
  camDeviceId?: string;
};

const PROBLEM_KEY = {
  denied: "call.preJoinDenied",
  "no-device": "call.preJoinNoDevice",
  "in-use": "call.preJoinInUse",
  unknown: "call.preJoinUnknown",
} as const;

// The check before a call connects: see yourself, see your microphone move,
// pick the devices, then join. The call used to connect the moment its page
// mounted and ask for the camera and microphone afterwards, so a blocked
// permission or a camera another app was holding was discovered mid-class,
// with the other person already waiting (lib/video/pre-join.ts has the rest).
//
// Joining is also a real tap, which is what iOS needs before it will play the
// other person's audio — the old join had no gesture at all.
//
// It releases its own preview before handing over, so the call's own capture
// is the only one holding the devices.
export function CallPreJoin({
  startAt,
  endAt,
  onJoin,
  onBack,
}: {
  startAt?: string;
  endAt?: string;
  onJoin: (choice: JoinChoice) => void;
  onBack: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [micId, setMicId] = useState<string | undefined>();
  const [camId, setCamId] = useState<string | undefined>();
  const [devices, setDevices] = useState<DeviceLike[]>([]);
  const [problem, setProblem] = useState<MediaProblem | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);

  const unsupported =
    typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function";
  const wantsMedia = micOn || camOn;

  // The preview: re-acquired whenever a device or a toggle changes, and every
  // track stopped when it is replaced or the check goes away.
  useEffect(() => {
    if (unsupported || !wantsMedia) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    const md = navigator.mediaDevices;
    md.getUserMedia({
      audio: micOn ? (micId ? { deviceId: { exact: micId } } : true) : false,
      video: camOn ? (camId ? { deviceId: { exact: camId } } : true) : false,
    })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        acquired = s;
        setStream(s);
        setProblem(null);
        // Labels and real ids only exist once permission is granted.
        const list = (await md.enumerateDevices?.()) ?? [];
        if (!cancelled) {
          setDevices(list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label })));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStream(null);
        setProblem(mediaProblemOf(err));
      });
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((track) => track.stop());
    };
  }, [unsupported, wantsMedia, micOn, camOn, micId, camId]);

  const live = wantsMedia ? stream : null;
  const hasVideo = Boolean(camOn && live?.getVideoTracks().length);
  const hasAudio = Boolean(micOn && live?.getAudioTracks().length);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = hasVideo ? live : null;
  }, [hasVideo, live]);

  // The microphone meter: an analyser on the preview's audio track.
  useEffect(() => {
    if (!hasAudio || !live) return;
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Chrome's autoplay policy creates an AudioContext SUSPENDED until the
    // page has had a user gesture, and a suspended analyser reports a stale
    // buffer: a meter frozen on a flat line, which reads as a dead
    // microphone. Resume now — enough when the person clicked their way here
    // — and again on their first tap or key, for a page opened from a link.
    const resume = () => {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    };
    resume();
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(live).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      setLevel(levelFromTimeDomain(samples));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
      void ctx.close();
    };
  }, [hasAudio, live]);

  const mics = devicesOfKind(devices, "audioinput");
  const cams = devicesOfKind(devices, "videoinput");
  const shownProblem: MediaProblem | null = unsupported ? "no-device" : problem;
  const meter = hasAudio ? level : 0;

  function join() {
    live?.getTracks().forEach((track) => track.stop());
    onJoin({
      mic: micOn && !shownProblem,
      cam: camOn && !shownProblem,
      micDeviceId: micId,
      camDeviceId: camId,
    });
  }

  return (
    <div data-testid="call-pre-join" className="flex h-full flex-col bg-black text-white">
      <CallTopBar notes={null} otherName={null} startAt={startAt} endAt={endAt} controls={null} />
      <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-4 py-6">
        <h2 className="text-center text-2xl font-semibold">{t("call.preJoinTitle")}</h2>

        <div className="relative aspect-video w-full max-w-xl overflow-hidden rounded-2xl border border-overlay-1 bg-scrim-3">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={cn(
              "ph-no-capture h-full w-full -scale-x-100 object-cover",
              !hasVideo && "invisible",
            )}
          />
          {!hasVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-on-dark-muted">
              <VideoOff className="h-8 w-8" aria-hidden />
              <span className="text-sm">{t("call.preJoinCameraOff")}</span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-3 p-3">
            <PreviewToggle
              on={micOn}
              onClick={() => setMicOn((v) => !v)}
              iconOn={Mic}
              iconOff={MicOff}
              label={micOn ? t("call.mute") : t("call.unmute")}
            />
            <PreviewToggle
              on={camOn}
              onClick={() => setCamOn((v) => !v)}
              iconOn={Video}
              iconOff={VideoOff}
              label={camOn ? t("call.cameraOff") : t("call.cameraOn")}
            />
          </div>
        </div>

        <div className="w-full max-w-xl space-y-1.5">
          <div className="flex items-center gap-2 text-sm text-on-dark-muted">
            {micOn ? (
              <Mic className="h-4 w-4" aria-hidden />
            ) : (
              <MicOff className="h-4 w-4" aria-hidden />
            )}
            <span id="pre-join-meter-label">{t("call.preJoinMicLevel")}</span>
          </div>
          <div
            role="meter"
            aria-labelledby="pre-join-meter-label"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meter * 100)}
            className="h-2 overflow-hidden rounded-full bg-overlay-1"
          >
            <div
              data-testid="pre-join-meter-fill"
              className="h-full rounded-full bg-success transition-all duration-75"
              style={{ width: `${Math.round(meter * 100)}%` }}
            />
          </div>
          {micOn && <p className="text-xs text-on-dark-faint">{t("call.preJoinHint")}</p>}
        </div>

        {(mics.length > 1 || cams.length > 1) && (
          <div className="grid w-full max-w-xl gap-3 text-foreground sm:grid-cols-2">
            {mics.length > 1 && (
              <DevicePicker
                label={t("call.preJoinMicrophone")}
                devices={mics}
                value={micId ?? mics[0].deviceId}
                onChange={setMicId}
              />
            )}
            {cams.length > 1 && (
              <DevicePicker
                label={t("call.preJoinCamera")}
                devices={cams}
                value={camId ?? cams[0].deviceId}
                onChange={setCamId}
              />
            )}
          </div>
        )}

        {shownProblem && (
          <p role="alert" className="max-w-xl text-center text-sm text-warning">
            {t(PROBLEM_KEY[shownProblem])}
          </p>
        )}

        <div className="flex flex-wrap justify-center gap-3">
          <Button size="lg" onClick={join} autoFocus data-testid="call-pre-join-join">
            {t("call.preJoinJoin")}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={onBack}
            className="text-white hover:bg-overlay-1 hover:text-white"
          >
            {t("call.preJoinBack")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PreviewToggle({
  on,
  onClick,
  iconOn: IconOn,
  iconOff: IconOff,
  label,
}: {
  on: boolean;
  onClick: () => void;
  iconOn: typeof Mic;
  iconOff: typeof Mic;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={cn(
        "h-12 w-12 rounded-full p-0 shadow-lg",
        on
          ? "bg-overlay-1 text-white backdrop-blur-md hover:bg-overlay-2 hover:text-white"
          : "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground",
      )}
    >
      {on ? (
        <IconOn className="h-5 w-5" aria-hidden />
      ) : (
        <IconOff className="h-5 w-5" aria-hidden />
      )}
    </Button>
  );
}

function DevicePicker({
  label,
  devices,
  value,
  onChange,
}: {
  label: string;
  devices: DeviceLike[];
  value: string;
  onChange: (deviceId: string) => void;
}) {
  return (
    <label className="space-y-1.5 text-sm">
      <span className="text-on-dark-muted">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {devices.map((d, i) => (
            <SelectItem key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
