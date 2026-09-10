"use client";

import { useEffect, useRef, useState } from "react";
import { Captions, RotateCcw } from "lucide-react";
import { CAPTION_LINES } from "./captions-demo.data";
import { revealTimeline } from "./captions-demo.logic";

// Account-free "feel it" demo of the live-captions moat: a Spanish teacher
// utterance streams in and its English translation appears beneath — exactly
// what the real in-class captions feature does. Pure timed JS on canned data
// (captions-demo.data.ts), no backend, no new deps. All visible chrome is
// passed in already-translated so the component stays i18n-guard-clean.
export function CaptionsDemo({
  badge,
  speakerLabel,
  translationLabel,
  replayLabel,
  a11yLabel,
}: {
  badge: string;
  speakerLabel: string;
  translationLabel: string;
  replayLabel: string;
  a11yLabel: string;
}) {
  const total = CAPTION_LINES.length;
  const [visible, setVisible] = useState(0);
  // Bumping runId re-runs the streaming effect (the "Replay" affordance).
  const [runId, setRunId] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const pending = timers.current;
    pending.forEach(clearTimeout);
    pending.length = 0;

    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      // No JS-driven streaming for motion-sensitive users — render the whole
      // transcript at once. (The CSS fade utility already no-ops under
      // reduced-motion, but the *timed sequencing* is JS and must be gated here.)
      setVisible(total);
      return;
    }

    setVisible(0);
    revealTimeline(CAPTION_LINES).forEach((at, i) => {
      pending.push(setTimeout(() => setVisible(i + 1), at));
    });

    return () => {
      pending.forEach(clearTimeout);
      pending.length = 0;
    };
  }, [runId, total]);

  const done = visible >= total;

  return (
    <div className="mx-auto max-w-xl">
      <div className="bg-card overflow-hidden rounded-2xl border shadow-xs">
        {/* Fake in-call header */}
        <div className="bg-secondary/40 flex items-center justify-between border-b px-4 py-2.5">
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            <Captions className="text-primary h-4 w-4" aria-hidden />
            {speakerLabel}
          </span>
          <span className="bg-destructive-bg text-destructive inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
            <span className="bg-destructive h-1.5 w-1.5 rounded-full" aria-hidden />
            {badge}
          </span>
        </div>

        {/* Caption stream — visual only; a screen-reader transcript follows. */}
        <ul className="flex min-h-[15rem] flex-col justify-end gap-3 p-4" aria-hidden>
          {CAPTION_LINES.slice(0, visible).map((line, i) => (
            <li key={`${runId}-${i}`} className="animate-fade-in-up">
              <p className="text-foreground text-sm font-medium">{line.es}</p>
              <p className="text-muted-foreground mt-0.5 text-sm">
                <span className="text-primary mr-1.5 align-middle text-sm font-semibold">
                  {translationLabel}
                </span>
                {line.en}
              </p>
            </li>
          ))}
        </ul>
      </div>

      {/* Full transcript for assistive tech, so AT isn't fed the drip-feed. */}
      <p className="sr-only">{a11yLabel}</p>
      <div className="sr-only">
        {CAPTION_LINES.map((line, i) => (
          <p key={i}>{`${line.es} — ${line.en}`}</p>
        ))}
      </div>

      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() => setRunId((n) => n + 1)}
          disabled={!done}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {replayLabel}
        </button>
      </div>
    </div>
  );
}
