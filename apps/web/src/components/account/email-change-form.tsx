"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { signInSchema, zodFieldErrors } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { OtpInput } from "@/components/ui/otp-input";
import { Label } from "@/components/ui/label";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { useLocale, useT } from "@/components/locale-provider";

// Shared verified email change (D-40, better-auth emailOTP changeEmail):
// step 1 sends a 6-digit code to the new address; step 2 verifies it and
// flips the identity in one call. Both the student (requestEmailChangeAction
// / verifyEmailChangeAction) and teacher (requestTeacherEmailChangeAction /
// verifyTeacherEmailChangeAction) flows pass actions of this exact shape.

export type EmailChangeState = { pendingEmail?: string; ok?: string; error?: string } | undefined;

export function EmailChangeForm({
  action,
  verifyAction,
  currentEmail,
  justChanged,
  hasGoogleLinked = false,
}: {
  action: (state: EmailChangeState, formData: FormData) => Promise<EmailChangeState>;
  verifyAction: (state: EmailChangeState, formData: FormData) => Promise<EmailChangeState>;
  currentEmail: string | null;
  // True right after a legacy link-based confirmation (?correo=actualizado) —
  // kept for any stale bookmarked link from before the code-only cutover.
  justChanged: boolean;
  // True when a Google account is currently linked for sign-in. Changing
  // email disconnects it (lib/auth/identity-change.ts) — this renders the
  // warning + required acknowledgement checkbox so that's never a surprise.
  hasGoogleLinked?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { errors, setErrors, clearError } = useFieldErrors<"newEmail">();
  const [ackGoogleDisconnect, setAckGoogleDisconnect] = useState(false);
  const [state, formAction, pending] = useActionState<EmailChangeState, FormData>(
    action,
    undefined,
  );
  const [verifyState, verifyFormAction, verifying] = useActionState<EmailChangeState, FormData>(
    verifyAction,
    undefined,
  );

  const sentTo = state?.pendingEmail ?? null;
  const done = justChanged || Boolean(verifyState?.ok);
  const [code, setCode] = useState("");
  const verifyFormRef = useRef<HTMLFormElement>(null);

  // Inline validation for the new-email step (canonical form pattern): validate
  // the shared email rule on submit and point at the field, instead of relying
  // only on the server action's single form-level error. React 19 honours
  // preventDefault in onSubmit, so an invalid address never dispatches.
  function handleSendSubmit(e: FormEvent<HTMLFormElement>) {
    const result = signInSchema(locale).safeParse({
      email: new FormData(e.currentTarget).get("newEmail"),
    });
    if (!result.success) {
      e.preventDefault();
      setErrors({ newEmail: zodFieldErrors(result.error).email });
    }
  }

  useEffect(() => {
    // A rejected code is never worth keeping around — clear it so the retry
    // starts from an empty field instead of the wrong digits.
    if (verifyState?.error) setCode("");
  }, [verifyState]);

  return (
    <div className="space-y-4">
      {done && (
        <Alert role="status" variant="success">
          {t("web.emailChangeForm.done")}
        </Alert>
      )}

      <div className="space-y-1">
        <Label htmlFor="current-email">{t("web.emailChangeForm.currentEmail")}</Label>
        <Input id="current-email" type="email" value={currentEmail ?? ""} disabled readOnly />
        <p className="text-xs text-muted-foreground">{t("web.emailChangeForm.currentEmailHint")}</p>
      </div>

      {!done && sentTo ? (
        <form ref={verifyFormRef} action={verifyFormAction} className="space-y-3">
          <input type="hidden" name="newEmail" value={sentTo} />
          <p className="text-sm">{t("web.emailChangeForm.codeSent", { email: sentTo })}</p>
          <div className="space-y-1">
            <Label htmlFor="email-change-code">{t("web.emailChangeForm.codeLabel")}</Label>
            <OtpInput
              id="email-change-code"
              name="code"
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={() => {
                if (!verifying) verifyFormRef.current?.requestSubmit();
              }}
            />
          </div>
          {verifyState?.error && (
            <p role="alert" className="text-sm text-destructive">
              {verifyState.error}
            </p>
          )}
          <Button type="submit" disabled={verifying}>
            {verifying ? t("web.emailChangeForm.verifying") : t("common.confirm")}
          </Button>
        </form>
      ) : !done ? (
        <form action={formAction} onSubmit={handleSendSubmit} noValidate className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-email">{t("web.emailChangeForm.newEmail")}</Label>
            <Input
              id="new-email"
              name="newEmail"
              type="email"
              required
              maxLength={254}
              placeholder={t("web.emailChangeForm.newEmailPlaceholder")}
              invalid={Boolean(errors.newEmail)}
              aria-describedby={errors.newEmail ? "new-email-error" : undefined}
              onChange={() => clearError("newEmail")}
            />
            <FieldError id="new-email-error" message={errors.newEmail} />
            <p className="text-xs text-muted-foreground">{t("web.emailChangeForm.newEmailHint")}</p>
          </div>
          {hasGoogleLinked && (
            <Alert variant="warning" className="space-y-2">
              <p className="text-sm">{t("web.emailChangeForm.googleWarning")}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ackGoogleDisconnect}
                  onChange={(e) => setAckGoogleDisconnect(e.target.checked)}
                  className="mt-0.5"
                />
                {t("web.emailChangeForm.googleConfirmLabel")}
              </label>
            </Alert>
          )}
          <Button type="submit" disabled={pending || (hasGoogleLinked && !ackGoogleDisconnect)}>
            {pending ? t("web.emailChangeForm.sending") : t("web.emailChangeForm.sendCode")}
          </Button>
          {state?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </form>
      ) : null}
    </div>
  );
}
