"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OtpInput } from "@/components/ui/otp-input";
import { useT } from "@/components/locale-provider";
import type { ActionState } from "@/app/actions/auth";

const CODE_LENGTH = 6;
// Auto-submit fires the instant the 6th digit lands. If that hasn't resolved
// (pending or errored) within this window, something's stuck — surface a
// manual fallback rather than leaving the user staring at a full code with
// no way forward.
const FALLBACK_DELAY_MS = 2500;

export function OtpVerifyCard({
  description,
  hiddenFields,
  verifyFormAction,
  verifyState,
  verifyPending,
  submitLabel,
  resend,
}: {
  description: string;
  hiddenFields: Record<string, string>;
  verifyFormAction: (formData: FormData) => void;
  verifyState: ActionState;
  verifyPending: boolean;
  submitLabel: string;
  resend: React.ReactNode;
}) {
  const t = useT();
  const [code, setCode] = useState("");
  const [showFallback, setShowFallback] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (code.length !== CODE_LENGTH || verifyPending) {
      setShowFallback(false);
      return;
    }
    // A failed attempt means auto-submit definitely already ran — no need to
    // wait out the delay before offering the fallback.
    if (verifyState?.error) {
      setShowFallback(true);
      return;
    }
    const timer = setTimeout(() => setShowFallback(true), FALLBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code, verifyPending, verifyState]);

  return (
    <Card>
      <CardHeader className="items-center gap-1.5 text-center">
        <CardTitle as="h1">{t("web.signIn.checkEmail.title")}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5">
        <form
          ref={formRef}
          action={verifyFormAction}
          className="flex w-full flex-col items-center gap-4"
        >
          {Object.entries(hiddenFields).map(([fieldName, value]) => (
            <input key={fieldName} type="hidden" name={fieldName} value={value} />
          ))}
          <OtpInput
            id="code"
            name="code"
            autoFocus
            length={CODE_LENGTH}
            value={code}
            onChange={setCode}
            disabled={verifyPending}
            onComplete={() => {
              if (!verifyPending) formRef.current?.requestSubmit();
            }}
            aria-label={t("web.auth.codeAria")}
            invalid={Boolean(verifyState?.error)}
            aria-describedby={verifyState?.error ? "verify-code-error" : undefined}
          />
          <div className="min-h-5" aria-live="polite">
            {verifyPending && (
              <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t("web.signIn.verifying")}
              </p>
            )}
          </div>
          {verifyState?.error && (
            <p
              id="verify-code-error"
              role="alert"
              aria-live="polite"
              className="text-destructive text-center text-sm"
            >
              {verifyState.error}
            </p>
          )}
          {/* No-JS fallback: a plain form post still works via the server action. */}
          <noscript>
            <Button type="submit" className="w-full">
              {submitLabel}
            </Button>
          </noscript>
          {showFallback && (
            <Button type="submit" variant="outline" size="sm" disabled={verifyPending}>
              {submitLabel}
            </Button>
          )}
        </form>
        <p className="text-muted-foreground text-center text-xs">{t("web.auth.noCodeHint")}</p>
        {resend}
      </CardContent>
    </Card>
  );
}
