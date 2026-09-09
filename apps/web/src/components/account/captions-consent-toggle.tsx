"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { setCaptionsConsent } from "@/app/actions/captions-consent";

// Live-captions self-consent (the captions architecture review
// P0, adult path) — the student's own toggle for whether her mic may be
// published to a third-party speech-recognition/AI-translation service
// during her classes. Off by default; applies across her whole identity set
// server-side (setCaptionsConsentForStudent). Mirrors the teacher-side
// InsightsConsentControl's toggle pattern, but this one is the student
// consenting for herself, not a teacher attesting on her behalf.
export function CaptionsConsentToggle({ initialConsented }: { initialConsented: boolean }) {
  const t = useT();
  const [consented, setConsented] = useState(initialConsented);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(next: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setCaptionsConsent(next);
      if (res.error) {
        setError(res.error);
      } else {
        setConsented(next);
      }
    });
  }

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant={consented ? "secondary" : "outline"}
        disabled={pending}
        onClick={() => submit(!consented)}
      >
        {consented
          ? t("web.myClasses.account.captionsConsent.recorded")
          : t("web.myClasses.account.captionsConsent.record")}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
