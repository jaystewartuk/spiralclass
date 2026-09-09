"use client";

import type { TFunction } from "@spiralclass/shared";

/** A recorded video message. The native controls carry their own keyboard and
 * screen-reader support, so this only supplies the label and the frame. */
export function VideoMessage({ videoUrl, t }: { videoUrl: string; t: TFunction }) {
  return (
    <video
      src={videoUrl}
      controls
      playsInline
      preload="metadata"
      aria-label={t("chat.media.video")}
      className="block max-h-attachment w-full rounded-xl bg-scrim-3"
    />
  );
}
