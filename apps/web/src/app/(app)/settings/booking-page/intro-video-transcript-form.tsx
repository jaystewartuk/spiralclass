"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FormStatus } from "@/components/ui/form-status";
import { ToggleField } from "@/components/ui/toggle-field";
import { useT } from "@/components/locale-provider";
import {
  saveIntroVideoTranscriptPublicOptInAction,
  type IntroVideoTranscriptOptInState,
} from "@/app/actions/profile";

// Booking-page AI-readability: explicit, separate opt-in to publish the
// intro-video TRANSCRIPT (not the video itself — that's already public) in
// the /b/<slug> JSON-LD. Only rendered by the parent once a transcript
// actually exists (IntroVideoAnalysisState.hasTranscript) — a Pro-only fact,
// since only the Pro coach pipeline generates one. Self-submitting toggle,
// the same pattern as the page's other toggles.
export function IntroVideoTranscriptForm({ initialOptedIn }: { initialOptedIn: boolean }) {
  const t = useT();
  const [optedIn, setOptedIn] = useState(initialOptedIn);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<IntroVideoTranscriptOptInState, FormData>(
    saveIntroVideoTranscriptPublicOptInAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(
        state.optedIn
          ? t("web.settings.bookingPage.video.transcriptOptIn.on")
          : t("web.settings.bookingPage.video.transcriptOptIn.off"),
      );
    }
  }, [state, t]);

  return (
    <form action={action} ref={formRef}>
      <ToggleField
        name="introVideoTranscriptPublicOptIn"
        checked={optedIn}
        onCheckedChange={(checked) => {
          setOptedIn(checked);
          formRef.current?.requestSubmit();
        }}
        label={t("web.settings.bookingPage.video.transcriptOptIn.label")}
        hint={t("web.settings.bookingPage.video.transcriptOptIn.hint")}
        status={
          <FormStatus
            state={state}
            pending={pending}
            savingMessage={t("web.settings.saving")}
            savedMessage={t("bookingPage.saved")}
          />
        }
      />
    </form>
  );
}
