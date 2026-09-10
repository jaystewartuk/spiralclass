"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { signInSchema, zodFieldErrors } from "@spiralclass/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import Link from "next/link";
import {
  requestSignInCodeAction,
  verifySignInCodeAction,
  type ActionState,
} from "@/app/actions/auth";
import { GoogleSignInButton } from "@/app/(auth)/google-sign-in-button";
import { ResendCodeButton } from "@/app/(auth)/resend-code-button";
import { OtpVerifyCard } from "@/app/(auth)/otp-verify-card";
import { useT, useLocale } from "@/components/locale-provider";
import { useFieldErrors } from "@/hooks/use-field-errors";
import type { StringKey } from "@/lib/i18n-translate";
import { HelpTip } from "@/components/help-tip";

// URL ?error= / ?notice= codes map to catalog keys, resolved through `t` at
// render time so both locales are covered.
const URL_ERROR_KEYS: Record<string, StringKey> = {
  "teacher-email-conflict": "web.auth.error.teacherEmailConflict",
  oauth: "web.auth.error.oauth",
  "no-account": "web.auth.error.noAccount",
};

const URL_NOTICE_KEYS: Record<string, StringKey> = {
  "different-account": "web.auth.notice.differentAccount",
};

export function SignInForm({
  next,
  error = null,
  notice = null,
  emailHint = "",
  googleEnabled = false,
}: {
  next: string;
  error?: string | null;
  notice?: string | null;
  emailHint?: string;
  googleEnabled?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { errors, setErrors, clearError } = useFieldErrors<"email">();
  const errorKey = error ? URL_ERROR_KEYS[error] : undefined;
  const noticeKey = notice ? URL_NOTICE_KEYS[notice] : undefined;
  const urlErrorMessage = errorKey ? t(errorKey) : null;
  const urlNoticeMessage = noticeKey ? t(noticeKey) : null;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    requestSignInCodeAction,
    undefined,
  );
  const [verifyState, verifyFormAction, verifyPending] = useActionState<ActionState, FormData>(
    verifySignInCodeAction,
    undefined,
  );

  const [email, setEmail] = useState("");
  // Captured at submit so the code-verify step below carries the email through.
  const submittedEmail = useRef("");

  useEffect(() => {
    // A notification-settings link tells us exactly which account this is
    // for — prefill the email field, but never clobber typed input.
    if (emailHint) {
      setEmail((current) => current || emailHint);
    }
  }, [emailHint]);

  if (state?.ok) {
    return (
      <OtpVerifyCard
        description={t("web.signIn.checkEmail.body")}
        hiddenFields={{ email: submittedEmail.current, next, intent: "sign-in" }}
        verifyFormAction={verifyFormAction}
        verifyState={verifyState}
        verifyPending={verifyPending}
        submitLabel={t("web.signIn.enter")}
        resend={
          <ResendCodeButton action={requestSignInCodeAction} email={submittedEmail.current} />
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1" className="flex items-center gap-1.5">
          {t("web.signIn.title")}
          <HelpTip
            text={t("web.help.hint.auth.text")}
            label={t("web.help.hint.auth.label")}
            learnMoreHref="/help"
            learnMoreLabel={t("web.help.learnMore")}
          />
        </CardTitle>
        <CardDescription>{t("web.signIn.subtitle")}</CardDescription>
      </CardHeader>
      {urlErrorMessage && (
        <CardContent className="pt-0">
          <p role="alert" aria-live="polite" className="text-destructive text-sm">
            {urlErrorMessage}
          </p>
        </CardContent>
      )}
      {!urlErrorMessage && urlNoticeMessage && (
        <CardContent className="pt-0">
          <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
            {urlNoticeMessage}
          </p>
        </CardContent>
      )}
      <form
        action={formAction}
        onSubmit={(event) => {
          submittedEmail.current = email;
          // Same schema the server enforces — a malformed/empty email lands
          // inline instead of only after the round-trip.
          const parsed = signInSchema(locale).safeParse({ email });
          if (!parsed.success) {
            event.preventDefault();
            setErrors(zodFieldErrors(parsed.error));
          }
        }}
      >
        <input type="hidden" name="next" value={next} />
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">
              {t("web.auth.emailLabel")}{" "}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              aria-required="true"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                clearError("email");
              }}
              invalid={Boolean(errors.email || state?.error)}
              aria-describedby={
                errors.email ? "sign-in-email-error" : state?.error ? "sign-in-error" : undefined
              }
            />
            <FieldError id="sign-in-email-error" message={errors.email} />
          </div>
          {state?.error && (
            <p
              id="sign-in-error"
              role="alert"
              aria-live="polite"
              className="text-destructive text-sm"
            >
              {state.error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("web.signIn.sending") : t("web.signIn.sendCode")}
          </Button>
          {googleEnabled && <GoogleSignInButton next={next || undefined} />}
          <p className="text-muted-foreground text-sm">
            {t("web.signIn.noAccount")}{" "}
            <Link href="/sign-up" className="underline">
              {t("web.signIn.createOne")}
            </Link>
          </p>
          <p className="text-muted-foreground text-xs">
            {t("web.signIn.terms")}{" "}
            <Link href="/privacy-notice" className="underline">
              {t("web.signUp.privacyNotice")}
            </Link>
            .
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
