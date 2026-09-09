"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { signUpSchema, zodFieldErrors } from "@spiralclass/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import {
  requestTeacherSignupCodeAction,
  verifySignInCodeAction,
  type ActionState,
} from "@/app/actions/auth";
import { GoogleSignInButton } from "@/app/(auth)/google-sign-in-button";
import { ResendCodeButton } from "@/app/(auth)/resend-code-button";
import { OtpVerifyCard } from "@/app/(auth)/otp-verify-card";
import { useT, useLocale } from "@/components/locale-provider";
import { useFieldErrors } from "@/hooks/use-field-errors";

export function SignUpForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { errors, setErrors, clearError } = useFieldErrors<"name" | "email">();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    requestTeacherSignupCodeAction,
    undefined,
  );
  const [verifyState, verifyFormAction, verifyPending] = useActionState<ActionState, FormData>(
    verifySignInCodeAction,
    undefined,
  );

  const [name, setName] = useState("");
  // Captured at submit so the code-verify step below carries the same email +
  // name through to account creation.
  const submittedEmail = useRef("");
  const submittedName = useRef("");

  if (state?.ok) {
    return (
      <OtpVerifyCard
        description={t("web.signUp.checkEmail.body")}
        hiddenFields={{
          email: submittedEmail.current,
          name: submittedName.current,
          next: "/onboarding/reading",
          intent: "sign-up",
        }}
        verifyFormAction={verifyFormAction}
        verifyState={verifyState}
        verifyPending={verifyPending}
        submitLabel={t("web.signUp.create")}
        resend={
          <ResendCodeButton
            action={requestTeacherSignupCodeAction}
            email={submittedEmail.current}
            extraFields={{ name: submittedName.current }}
          />
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{t("web.signUp.title")}</CardTitle>
        <CardDescription>{t("web.signUp.subtitle")}</CardDescription>
      </CardHeader>
      <form
        action={formAction}
        onSubmit={(event) => {
          const data = new FormData(event.currentTarget);
          const email = typeof data.get("email") === "string" ? String(data.get("email")) : "";
          submittedEmail.current = email;
          submittedName.current = name;
          // Validate on submit against the same schema the server enforces, so
          // an empty name or a malformed email lands inline next to its field
          // instead of only after the server round-trip.
          const parsed = signUpSchema(locale).safeParse({ name, email });
          if (!parsed.success) {
            event.preventDefault();
            setErrors(zodFieldErrors(parsed.error));
          }
        }}
      >
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">
              {t("web.signUp.nameLabel")}{" "}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              aria-required="true"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                clearError("name");
              }}
              invalid={Boolean(errors.name || state?.error)}
              aria-describedby={
                errors.name ? "sign-up-name-error" : state?.error ? "sign-up-error" : undefined
              }
            />
            <FieldError id="sign-up-name-error" message={errors.name} />
          </div>
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
              onChange={() => clearError("email")}
              invalid={Boolean(errors.email || state?.error)}
              aria-describedby={
                errors.email ? "sign-up-email-error" : state?.error ? "sign-up-error" : undefined
              }
            />
            <FieldError id="sign-up-email-error" message={errors.email} />
          </div>
          {state?.error && (
            <p
              id="sign-up-error"
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {state.error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("web.signIn.sending") : t("web.signUp.create")}
          </Button>
          {googleEnabled && <GoogleSignInButton intent="sign-up" />}
          <p className="text-sm text-muted-foreground">
            {t("web.signUp.haveAccount")}{" "}
            <Link href="/sign-in" className="underline">
              {t("web.signUp.signInLink")}
            </Link>
          </p>
          <p className="text-xs text-muted-foreground">
            {t("web.signUp.terms")}{" "}
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
