"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { setCaptionsConsent } from "@/app/actions/captions-consent";

// The student's captions consent, asked on her own call screen at the moment
// it matters: her teacher has just turned captions on, and without it her
// teacher reads nothing of what she says (see lib/captions/consent-prompt.ts).
// It is the same self-service consent as the toggle on her account page —
// her own tap, the same disclosure, the same write across all her teachers —
// asked where she already is instead of where she would have to go looking.
export function CaptionsConsentAsk({
  onGiven,
  onDismiss,
}: {
  // Her consent is recorded: re-read the caption config so captioning starts.
  onGiven: () => void;
  // "Not now" — for this call only. She is asked again next class.
  onDismiss: () => void;
}) {
  const t = useT();
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(false);
    startTransition(async () => {
      const res = await setCaptionsConsent(true);
      if (res.ok) onGiven();
      else setError(true);
    });
  }

  return (
    <div
      role="region"
      aria-label={t("call.captionsConsentAskTitle")}
      className="pointer-events-auto w-full max-w-md rounded-2xl bg-background p-4 text-left text-foreground shadow-lg"
    >
      <p className="font-semibold">{t("call.captionsConsentAskTitle")}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t("call.captionsConsentAskBody")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={accept}>
          {t("call.captionsConsentAskAccept")}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>
          {t("call.captionsConsentAskLater")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t("call.captionsConsentAskFailed")}
        </p>
      )}
    </div>
  );
}
