"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * A recorded screen of the real app, on the landing page.
 *
 * The clips are recorded from the running product by
 * scripts/marketing/record.mjs and shipped as muted H.264 under
 * public/marketing/. This plays one the way a product clip should be played:
 * it starts when it scrolls into view and stops when it leaves, loops, never
 * makes a sound, and fetches nothing but its metadata until it plays (the
 * poster carries the first impression). A reader who asked the OS for less
 * motion gets the poster and the browser's own controls instead of autoplay.
 *
 * Presentational and string-free: the accessible description of what the clip
 * shows is passed in, already translated, so this file never touches the
 * catalog.
 */
export function FeatureClip({
  name,
  label,
  orientation = "landscape",
  className,
}: {
  /** The clip's basename under public/marketing (`<name>.mp4`, `<name>.jpg`). */
  name: string;
  /** What the clip shows, for a reader who cannot see it. */
  label: string;
  orientation?: "landscape" | "portrait";
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video || reducedMotion || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // `play()` rejects when the browser refuses autoplay; the poster
            // then stays, which is the right fallback.
            video.play().catch(() => undefined);
          } else {
            video.pause();
          }
        }
      },
      // Start a little before the clip is fully on screen, so the first frame
      // a reader sees is already moving.
      { threshold: 0.35 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <figure className={cn("m-0", className)}>
      <div
        className={cn(
          "overflow-hidden rounded-2xl border bg-card shadow-md",
          orientation === "portrait" ? "mx-auto w-full max-w-xs" : "w-full",
        )}
      >
        <video
          ref={ref}
          src={`/marketing/${name}.mp4`}
          poster={`/marketing/${name}.jpg`}
          aria-label={label}
          muted
          loop
          playsInline
          preload="metadata"
          controls={reducedMotion}
          className="block h-auto w-full"
        />
      </div>
    </figure>
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

// The media query as an external store: the server renders "no preference"
// (there is no window to ask), the client reads the real answer on hydration
// and follows changes, with no state set from inside an effect.
function subscribeReducedMotion(onChange: () => void): () => void {
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}
