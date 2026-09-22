"use client";

import type { TFunction } from "@spiralclass/shared";

/**
 * An inline photo. Tapping it opens the full-size signed URL in a new tab.
 *
 * The aspect ratio is reserved from the stored dimensions so the thread does
 * not reflow as photos load — the one thing that makes a chat scroll feel
 * broken. `style` carries a computed ratio because there is no utility for an
 * arbitrary one.
 */
export function ImageMessage({
  imageUrl,
  width,
  height,
  t,
}: {
  imageUrl: string;
  width: number | null;
  height: number | null;
  t: TFunction;
}) {
  const aspectRatio = width && height ? `${width} / ${height}` : "4 / 3";
  return (
    <a
      href={imageUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={t("chat.media.photoOpen")}
      className="block overflow-hidden rounded-xl"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed R2 URL, not a Next-optimizable static asset */}
      <img
        src={imageUrl}
        alt={t("chat.media.photo")}
        style={{ aspectRatio }}
        className="h-auto w-full bg-muted object-cover"
        loading="lazy"
      />
    </a>
  );
}
