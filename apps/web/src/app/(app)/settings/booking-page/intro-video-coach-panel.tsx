"use client";

import { useEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { Loader2, Sparkles } from "lucide-react";
import type { IntroVideoAnalysisStatus } from "@spiralclass/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import {
  getIntroVideoAnalysisStateAction,
  retryIntroVideoAnalysisAction,
} from "@/app/actions/profile";

export type IntroVideoAnalysisPanelState = {
  status: IntroVideoAnalysisStatus | null;
  coach: { overall: string; strengths: string[]; improvements: string[] } | null;
  error: string | null;
};

// Poll cadence + hard cap while the pipeline is running. Capped so a genuinely
// stuck job doesn't poll forever — it just softens to a "still working"
// message instead.
const POLL_MS = 4000;
const MAX_POLL_MS = 3 * 60 * 1000;

const PROCESSING_STATUSES: IntroVideoAnalysisStatus[] = ["pending", "transcribing"];

// AI Coach feedback panel (D-73, Layer 3). Seeded from the server-rendered
// `initial` state (so a fresh page load — including "left and came back" —
// always reflects the true current status with no refresh needed), then
// polls while the pipeline is still running so a teacher who stays on the
// page also sees it resolve live, without needing to reload.
export function IntroVideoCoachPanel({
  initial,
  hidden,
}: {
  initial: IntroVideoAnalysisPanelState;
  hidden: boolean;
}) {
  const t = useT();
  const posthog = usePostHog();
  const [state, setState] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const elapsedRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const processing =
    state.status != null && PROCESSING_STATUSES.includes(state.status) && !state.coach;

  useEffect(() => {
    if (!processing) return;
    elapsedRef.current = 0;
    setStillWorking(false);
    async function tick() {
      elapsedRef.current += POLL_MS;
      if (elapsedRef.current >= MAX_POLL_MS) {
        setStillWorking(true);
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        return;
      }
      const next = await getIntroVideoAnalysisStateAction();
      setState(next);
    }
    pollTimerRef.current = setInterval(tick, POLL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [processing]);

  async function retry() {
    posthog?.capture("intro_video_coach_retry_clicked", { surface: "web" });
    setRetrying(true);
    try {
      const res = await retryIntroVideoAnalysisAction();
      if (res?.ok) setState({ status: "pending", coach: null, error: null });
    } finally {
      setRetrying(false);
    }
  }

  // "How often is AI analysis generated" is a server question; "how often does
  // a teacher actually SEE it" is this one, and the gap between them is the
  // part of the funnel that decides whether the coach changes any behaviour.
  // Keyed on the feedback's own content so a re-analysis is a fresh view, but
  // a re-render or a poll tick is not.
  // Keyed on the feedback's own content, and reduced to primitives BEFORE the
  // effect, so the dependency list is honest — depending on the `state` object
  // would re-fire on every poll tick and double-count the view.
  const coachKey = state.coach ? JSON.stringify(state.coach).slice(0, 64) : null;
  const strengthsCount = state.coach?.strengths.length ?? 0;
  const improvementsCount = state.coach?.improvements.length ?? 0;
  useEffect(() => {
    if (hidden || !coachKey) return;
    posthog?.capture("intro_video_coach_viewed", {
      surface: "web",
      strengths: strengthsCount,
      improvements: improvementsCount,
    });
  }, [coachKey, hidden, posthog, strengthsCount, improvementsCount]);

  if (hidden || state.status === null) return null;

  if (processing) {
    return (
      <Alert variant="info">
        <Loader2 className="animate-spin" aria-hidden />
        <AlertTitle>{t("web.settings.bookingPage.video.coachProcessingTitle")}</AlertTitle>
        <AlertDescription>
          {stillWorking
            ? t("web.settings.bookingPage.video.coachStillWorking")
            : t("web.settings.bookingPage.video.coachProcessingHelp")}
        </AlertDescription>
      </Alert>
    );
  }

  if (state.status === "failed") {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("web.settings.bookingPage.video.coachFailedTitle")}</AlertTitle>
        <AlertDescription className="space-y-2">
          {state.error && <p>{state.error}</p>}
          <Button type="button" size="sm" variant="outline" onClick={retry} disabled={retrying}>
            {retrying
              ? t("web.settings.bookingPage.video.coachRetrying")
              : t("web.settings.bookingPage.video.coachRetry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!state.coach) return null;

  const { coach } = state;
  return (
    <Alert variant="info">
      <Sparkles aria-hidden />
      <AlertTitle>{t("web.settings.bookingPage.video.coachTitle")}</AlertTitle>
      <AlertDescription className="space-y-2">
        {coach.overall && <p>{coach.overall}</p>}
        {coach.strengths.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t("web.settings.bookingPage.video.coachStrengths")}
            </p>
            <ul className="list-disc pl-5">
              {coach.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {coach.improvements.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t("web.settings.bookingPage.video.coachImprovements")}
            </p>
            <ul className="list-disc pl-5">
              {coach.improvements.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
