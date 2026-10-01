"use client";

import type { CSSProperties } from "react";
import { MicOff } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import type { RemoteParticipantView } from "@/lib/video/remote-participant";

// What the other person's tile shows while their camera is off. It used to
// show nothing: a black stage with no name and no sign that anyone was there,
// so a teacher could not tell a student who had turned the camera off from a
// call that had dropped, or a muted student from a silent one.
//
// Initials and name in the middle, a microphone-off badge when muted, and a
// ring that lights while they speak — the cue every call app gives for "who
// is talking", and on a camera-off call the only one. Sized for the stage
// ("big") or the floating corner tile ("tile"); it sits over the video
// container in the same box and lets pointer events through, so dragging or
// tapping the tile still works exactly as with video.
export function ParticipantPlaceholder({
  view,
  size,
  style,
}: {
  view: RemoteParticipantView;
  size: "big" | "tile";
  style: CSSProperties;
}) {
  const t = useT();
  const big = size === "big";
  const label = t("call.cameraOffNamed", { name: view.name ?? "—" });
  return (
    <div
      role="img"
      aria-label={label}
      data-testid="participant-placeholder"
      style={style}
      className={cn(
        "pointer-events-none flex flex-col items-center justify-center gap-3 bg-scrim-3",
        !big && "rounded-lg",
      )}
    >
      <div className="relative">
        <div
          data-speaking={view.speaking || undefined}
          className={cn(
            "flex items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground ring-offset-black transition-shadow",
            big ? "h-24 w-24 text-3xl" : "h-12 w-12 text-base",
            view.speaking ? "ring-4 ring-success ring-offset-4" : "ring-0",
          )}
        >
          {view.initials}
        </div>
        {!view.micOn && (
          <span
            data-testid="participant-mic-off"
            className={cn(
              "absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground",
              big ? "h-8 w-8" : "h-5 w-5",
            )}
          >
            <MicOff className={big ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
            <span className="sr-only">{t("call.micOffBadge")}</span>
          </span>
        )}
      </div>
      {big && view.name && (
        <p className="max-w-xs truncate px-4 text-lg font-medium text-white">{view.name}</p>
      )}
    </div>
  );
}
