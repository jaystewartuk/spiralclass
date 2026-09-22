"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/components/locale-provider";
import { setInsightsConsent } from "@/app/actions/insights-consent";
import { setCaptionsGuardianConsent } from "@/app/actions/captions-consent";

// Lesson-insights consent gate (D-22). The teacher records the per-student
// consent that voice capture for the insights pipeline is gated on, and flags
// whether the student is a minor (then a guardian's consent is the one that
// counts). Off by default — capture stays disabled until consent is recorded.
//
// Also hosts the sibling live-captions GUARDIAN consent control (docs/
// architecture/LIVEKIT_CAPTIONS_AUDIT.md P0) — a separate consent record from
// insights above, but sharing this component because both branch on the same
// `isMinor` flag for this pairing. Only meaningful when isMinor is checked:
// an adult student consents to captions herself, from her own account page
// (see components/account/captions-consent-toggle.tsx), never via the
// teacher.
export function InsightsConsentControl({
  studentId,
  consented: consentedInit,
  isMinor: isMinorInit,
  captionsGuardianConsented: captionsConsentedInit,
}: {
  studentId: string;
  consented: boolean;
  isMinor: boolean;
  captionsGuardianConsented: boolean;
}) {
  const t = useT();
  const [consented, setConsented] = useState(consentedInit);
  const [isMinor, setIsMinor] = useState(isMinorInit);
  const [captionsConsented, setCaptionsConsented] = useState(captionsConsentedInit);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Every change submits the combined (isMinor, consented) state so the server
  // writes the timestamp into the field that counts for this pair.
  function submit(next: { isMinor: boolean; consented: boolean }) {
    setError(null);
    startTransition(async () => {
      const res = await setInsightsConsent(studentId, next);
      if (res.error) {
        setError(res.error);
      } else {
        setIsMinor(next.isMinor);
        setConsented(next.consented);
      }
    });
  }

  function submitCaptions(next: { isMinor: boolean; consented: boolean }) {
    setError(null);
    startTransition(async () => {
      const res = await setCaptionsGuardianConsent(studentId, next);
      if (res.error) {
        setError(res.error);
      } else {
        setIsMinor(next.isMinor);
        setCaptionsConsented(next.consented);
      }
    });
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={isMinor}
          disabled={pending}
          onCheckedChange={(v) => submit({ isMinor: v === true, consented })}
        />
        {t("web.insightsConsent.minorLabel")}
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={consented ? "secondary" : "outline"}
          disabled={pending}
          onClick={() => submit({ isMinor, consented: !consented })}
        >
          {consented ? t("web.insightsConsent.recorded") : t("web.insightsConsent.record")}
        </Button>

        {isMinor ? (
          <Button
            size="sm"
            variant={captionsConsented ? "secondary" : "outline"}
            disabled={pending}
            onClick={() => submitCaptions({ isMinor, consented: !captionsConsented })}
          >
            {captionsConsented
              ? t("web.captionsConsent.recorded")
              : t("web.captionsConsent.record")}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t("web.captionsConsent.adultNote")}</p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
