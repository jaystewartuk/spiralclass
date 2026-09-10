"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import {
  emptyIntroVideoWatchState,
  foldIntroVideoTick,
  introVideoNewMilestones,
  introVideoWatchSummary,
  type IntroVideoWatchState,
} from "@spiralclass/shared";
import { LogoMark } from "@/components/brand/logo";
import { useT } from "@/components/locale-provider";
import { markIntroVideoWatched } from "@/lib/analytics/intro-video-watch";

// Public-page intro video card (D-73). Previously used the teacher's profile
// photo as the <video poster>, which duplicated the same headshot twice on
// the page (once as the hero photo, again squashed into the video frame) and
// read as a bug rather than a thumbnail. So it renders a branded play overlay
// instead — no new binary asset, no schema change, fully theme-aware — and
// hides it once playback starts.
//
// That overlay was OPAQUE until 2026-08-30, which solved the duplicate-headshot
// problem by replacing it with a worse one: the card was a flat rectangle of
// brand gradient, and a visitor deciding whether to spend five minutes on a
// stranger could not see the stranger. It is a translucent scrim now, over the
// video's own first frame (`#t=0.1` on the src — a media fragment, which is
// what makes the browser paint a frame at all rather than leave the element
// transparent). Costs no asset and no schema, same as before.
//
// A real generated video-frame thumbnail is still the better end state and is
// still a drop-in swap: pass a `thumbnailUrl` prop rendered as the overlay's
// background image; nothing else about this component's structure changes.
//
// Instrumented for the conversion question this card exists to answer: does
// watching the intro make a visitor more likely to buy? Impression (did they
// scroll far enough to SEE it) is measured separately from play, because a
// low play rate and a low impression rate call for opposite fixes — better
// thumbnail vs. higher placement.
// How long a first frame gets before the preload upgrade is called off. Long
// enough for a faststart file on a slow connection to decode frame one, far
// short of what a 50 MB non-faststart file would need to arrive in full.
const ABORT_MS = 3000;

/**
 * Whether the visitor has asked us not to spend their data, or is on a
 * connection where several megabytes is rude. `navigator.connection` is
 * Chromium-only and absent on Safari and Firefox, where this reads false and
 * the upgrade proceeds — the same default those browsers get today.
 */
function prefersLightData(): boolean {
  const conn = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

export function IntroVideoCard({
  videoUrl,
  teacherName,
  teacherId,
  slug,
}: {
  videoUrl: string;
  teacherName: string;
  teacherId: string;
  slug: string;
}) {
  const t = useT();
  const posthog = usePostHog();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [started, setStarted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [errored, setErrored] = useState(false);
  // Whether a real video frame is decoded and painted underneath the overlay.
  // Drives the overlay's opacity, and nothing else: the scrim may only go
  // translucent once there is something to see through it. See the render.
  const [frameReady, setFrameReady] = useState(false);

  // Playback accounting lives in refs, not state: a timeupdate fires ~4x/sec
  // and none of this is rendered, so putting it in state would re-render the
  // card 4x/sec for nothing.
  const watchRef = useRef<IntroVideoWatchState>(emptyIntroVideoWatchState());
  const lastTickRef = useRef<number | null>(null);
  const milestonesRef = useRef<number[]>([]);
  const impressedRef = useRef(false);

  // Stamped on every playback event so a per-teacher breakdown works without a
  // join. Used by the plain event handlers below; the two memoised effects
  // spell the same two fields out inline so their dependency lists stay honest.
  const base = { teacher_id: teacherId, slug };

  // One summary event per visitor per page — emitted on unmount/pagehide
  // rather than as a stream, so watch duration survives the visitor closing
  // the tab (the most common way a session ends) without paying for a
  // timeupdate-shaped firehose. Skipped entirely when they never pressed play.
  const flushWatch = useCallback(() => {
    const state = watchRef.current;
    if (state.playCount === 0) return;
    watchRef.current = emptyIntroVideoWatchState(); // never double-report
    posthog?.capture("intro_video_watch_ended", {
      teacher_id: teacherId,
      slug,
      ...introVideoWatchSummary(state),
    });
  }, [posthog, teacherId, slug]);

  useEffect(() => {
    window.addEventListener("pagehide", flushWatch);
    return () => {
      window.removeEventListener("pagehide", flushWatch);
      flushWatch();
    };
  }, [flushWatch]);

  // Impression: the card actually entered the viewport. On this page the video
  // sits below the hero, so a plain "rendered" count would badly overstate how
  // many visitors ever had the chance to press play.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || impressedRef.current) continue;
          impressedRef.current = true;
          posthog?.capture("intro_video_impression", { teacher_id: teacherId, slug });

          // Upgrade preload once the card is actually on screen, so the
          // `#t=0.1` fragment on the element below has bytes to seek into and
          // paints a real frame of her instead of the branded block.
          //
          // This was reverted on 2026-08-30, and the revert was right ON THE
          // FILE THAT EXISTED THEN: a 42 MB MP4 whose `moov` atom sat at the
          // END (`ftyp` straight into `mdat`). A browser cannot decode any
          // frame without the index, so that file had to arrive in full before
          // it painted one pixel — "auto" bought 42 MB and still showed a
          // rectangle.
          //
          // Both of those premises were re-measured on 2026-08-31 and both are
          // gone. The live file is 6.3 MB, and its first bytes are `ftyp` then
          // `moov` at offset 32 — it is faststart. So the browser can decode
          // frame one from the front of the file and stream the rest, which is
          // the case "auto" is for and the case the revert never applied to.
          //
          // What is NOT fixed, and is the reason to keep this narrow: nothing
          // validates faststart at upload, and MAX_VIDEO_BYTES is 50 MB, so the
          // next upload could put us back. The abort below is that guard — if a
          // frame has not arrived in ABORT_MS, the fetch is cancelled and the
          // card falls back to exactly today's behaviour rather than pulling
          // tens of megabytes on someone's mobile data. A non-faststart file
          // cannot decode a frame quickly by construction, so this catches
          // precisely the shape that caused the revert, without needing to know
          // the file's size (a HEAD to R2 would be a cross-origin round trip).
          const video = videoRef.current;
          if (video && !prefersLightData()) {
            video.preload = "auto";
            const abort = window.setTimeout(() => {
              // Still nothing decodable: stop paying for it. readyState >= 2
              // (HAVE_CURRENT_DATA) means a frame is in hand.
              if (video.readyState < 2) video.preload = "none";
            }, ABORT_MS);
            video.addEventListener("loadeddata", () => window.clearTimeout(abort), {
              once: true,
            });
          }

          observer.disconnect();
        }
      },
      // Half the card visible — enough that the play button is genuinely on
      // screen, not a single pixel clipping into view.
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [posthog, teacherId, slug]);

  function play() {
    setBuffering(true);
    void videoRef.current?.play().catch(() => setBuffering(false));
  }

  function onPlay() {
    setStarted(true);
    lastTickRef.current = null;
    const state = watchRef.current;
    const isReplay = state.completed || state.playCount > 0;
    watchRef.current = { ...state, playCount: state.playCount + 1 };
    posthog?.capture("intro_video_play", {
      ...base,
      play_index: watchRef.current.playCount,
      is_replay: isReplay,
    });
    // The checkout form reads this back, so `checkout_started` can be split by
    // "did this buyer watch the intro?" — the correlation the whole feature is
    // justified by. Set on first play, upgraded as they watch further.
    markIntroVideoWatched(slug, 0);
  }

  function onTimeUpdate() {
    const el = videoRef.current;
    if (!el) return;
    const duration = el.duration;
    watchRef.current = foldIntroVideoTick(
      watchRef.current,
      el.currentTime,
      lastTickRef.current,
      duration,
    );
    lastTickRef.current = el.currentTime;

    for (const milestone of introVideoNewMilestones(
      el.currentTime,
      duration,
      milestonesRef.current,
    )) {
      milestonesRef.current.push(milestone);
      posthog?.capture("intro_video_progress", { ...base, percent: milestone });
    }
    markIntroVideoWatched(slug, Math.round(watchRef.current.maxPercent));
  }

  function onEnded() {
    watchRef.current = { ...watchRef.current, completed: true, maxPercent: 100 };
    posthog?.capture("intro_video_completed", {
      ...base,
      play_index: watchRef.current.playCount,
    });
    markIntroVideoWatched(slug, 100);
  }

  return (
    <div
      ref={frameRef}
      className="relative mx-auto aspect-[9/16] w-full max-w-xs overflow-hidden rounded-2xl border bg-black shadow-sm"
    >
      <video
        ref={videoRef}
        // `#t=0.1` is a media fragment asking the browser to seek to the first
        // tenth of a second, so what it paints is a real frame of her rather
        // than black. It is NOT sufficient on its own — a seek cannot render
        // media that was never fetched, which is why the preload bump in the
        // impression observer above exists. Shipping the fragment alone left
        // production at readyState 0 / videoWidth 0, painting nothing.
        src={`${videoUrl}#t=0.1`}
        // Native controls only once she has pressed play. Before that they
        // rendered as a second control bar underneath the overlay's own play
        // button — two competing affordances for one action, the lower of
        // which was half-clipped by the frame.
        controls={started}
        playsInline
        // "metadata", not "none": `none` meant the first tap paid a full
        // round-trip before anything moved (the play button just sat there on a
        // phone connection), and left `duration` NaN — so the quartile
        // milestones below couldn't be computed until playback was already
        // under way. Metadata is a few KB of headers, not the media.
        //
        // It is upgraded to "auto" when the card scrolls into view — the
        // initial value has to stay "metadata" so a visitor who never reaches
        // the card never downloads the video.
        preload="metadata"
        // Fires once a frame is actually decoded. Until then the overlay stays
        // opaque, so a scrim is never drawn over an empty element.
        onLoadedData={() => setFrameReady(true)}
        aria-label={`${t("bookingPage.introVideo")} — ${teacherName}`}
        // `contain`, not `cover`: a teacher who uploads a landscape clip from
        // her gallery was previously centre-cropped to a vertical slice of the
        // frame, which routinely cut her own head off. Letterboxing inside the
        // black frame shows the whole take instead.
        className="h-full w-full object-contain"
        onPlay={onPlay}
        onPlaying={() => setBuffering(false)}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onError={() => setErrored(true)}
      />
      {!started && (
        <button
          type="button"
          onClick={play}
          disabled={errored}
          aria-label={errored ? t("bookingPage.videoUnavailable") : t("bookingPage.watchIntro")}
          // A scrim ONLY once there is something to see through it.
          //
          // Opaque and translucent are each right at a different moment, and
          // shipping either unconditionally is wrong. Opaque always: the card
          // is a flat coloured rectangle and a visitor never sees who they
          // would be listening to — the original bug. Translucent always: on
          // first paint no frame is decoded yet (readyState 0), so the wash
          // sits over an empty black element and reads as washed out, which is
          // exactly what production looked like after the previous attempt.
          //
          // So it is keyed on `frameReady`, set by the video's own
          // `loadeddata`. Before: a deliberate brand block. After: her face,
          // tinted enough that white text and the play button stay legible
          // over a frame nobody has vetted.
          className={`${
            frameReady
              ? "from-primary/85 via-primary/60 to-primary/80"
              : "from-primary to-primary/70"
          } text-primary-foreground focus-visible:ring-ring absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-br transition-all duration-500 outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-offset-2 disabled:cursor-default disabled:hover:opacity-100`}
        >
          {errored ? (
            <>
              <LogoMark variant="inverted" size={36} />
              <span className="text-primary-foreground max-w-[80%] text-center text-sm">
                {t("bookingPage.videoUnavailable")}
              </span>
            </>
          ) : (
            <>
              <LogoMark variant="inverted" size={36} />
              <span className="bg-overlay-4 text-primary flex h-14 w-14 items-center justify-center rounded-full shadow">
                {buffering ? (
                  <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                ) : (
                  <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" aria-hidden />
                )}
              </span>
              <span className="text-sm font-medium">{t("bookingPage.watchIntro")}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
