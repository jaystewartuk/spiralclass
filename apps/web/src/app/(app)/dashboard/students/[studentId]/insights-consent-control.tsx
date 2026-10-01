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
// Also hosts the sibling live-captions consent — a separate consent record
// from insights above, but sharing this component because both branch on the
// same `isMinor` flag for this pairing. For a minor the teacher records the
// guardian's consent here; an adult student gives her own, never via the
// teacher (on her account page, or with one tap when a class's captions come
// on — components/video/captions-consent-ask.tsx), so for an adult this only
// SHOWS whether she has.
//
// Each consent sits under its own heading. They used to share one row, where
// the insights button's bare "✓ Consent on file" sat right above a captions
// note and read as the captions consent — a teacher looking at a student who
// had never turned captions on was told, in effect, that he had.
export function InsightsConsentControl({
  studentId,
  consented: consentedInit,
  isMinor: isMinorInit,
  captionsGuardianConsented: captionsConsentedInit,
  captionsSelfConsented,
}: {
  studentId: string;
  consented: boolean;
  isMinor: boolean;
  captionsGuardianConsented: boolean;
  // The adult student's own captions consent (read-only here).
  captionsSelfConsented: boolean;
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
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={isMinor}
          disabled={pending}
          onCheckedChange={(v) => submit({ isMinor: v === true, consented })}
        />
        {t("web.insightsConsent.minorLabel")}
      </label>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("web.insightsConsent.heading")}</h4>
        <Button
          size="sm"
          variant={consented ? "secondary" : "outline"}
          disabled={pending}
          onClick={() => submit({ isMinor, consented: !consented })}
        >
          {consented ? t("web.insightsConsent.recorded") : t("web.insightsConsent.record")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("web.studentProfile.consentNote")}</p>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("web.captionsConsent.heading")}</h4>
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
          <p className="text-xs text-muted-foreground">
            {captionsSelfConsented
              ? t("web.captionsConsent.selfOn")
              : t("web.captionsConsent.selfOff")}
          </p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
