"use client";

import { useState } from "react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

// Inline preview for a material whose FILE attachment is a picture (step 1 of
// the images-for-visual-learners work). Before this, an uploaded flashcard or
// worksheet image was a bare "open this" link — the student had to leave the
// page to find out what it even was.
//
// It renders BESIDE the existing open/download affordance rather than
// replacing it: the link is still how you get the full-resolution file, and
// every non-image attachment keeps working exactly as before.
//
// Failure is silent by design. `viewUrl` is a signed URL with a 7-day TTL, so
// a page held open across the expiry, or an image whose object has been
// purged, would otherwise render a broken-image glyph next to a link that
// still works. On error the preview simply removes itself and the surface
// falls back to the link it already had.

export function MaterialImagePreview({
  viewUrl,
  label,
  className,
}: {
  viewUrl: string | null;
  /** The material's own label — the best alt text available, since no
   * separate alt is stored for a file attachment. */
  label: string | null;
  className?: string;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (!viewUrl || failed) return null;

  // An unlabelled picture is decorative (alt=""), which left the LINK around it
  // with no accessible name at all — axe reports it as a serious violation, and
  // a screen-reader user reaches a tab stop that announces only its URL. The
  // fallback names the link rather than the image, so a labelled picture still
  // gets its own name from the alt text and is not announced twice.
  const name = label?.trim();

  return (
    <a
      href={viewUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={name ? undefined : t("common.image")}
      className={cn(
        "border-border bg-muted/30 block overflow-hidden rounded-lg border transition-opacity hover:opacity-90",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed URL the
          Next image optimizer can neither reach nor usefully cache. */}
      <img
        src={viewUrl}
        alt={label ?? ""}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="max-h-64 w-full object-contain"
      />
    </a>
  );
}
