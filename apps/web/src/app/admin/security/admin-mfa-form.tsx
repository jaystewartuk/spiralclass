"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toDataURL } from "qrcode";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/ui/otp-input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  startAdminMfaEnrollmentAction,
  verifyAdminMfaEnrollmentAction,
  verifyAdminMfaStepUpAction,
} from "@/app/actions/admin-mfa";

// Admin TOTP enrolment + per-session step-up (D-40 narrows D-25 to TOTP-only —
// no WebAuthn/passkeys). Reached in two states (admin/security/page.tsx):
//   * NOT enrolled → scan/verify to enrol.
//   * enrolled but no fresh step-up proof → enter the current code (security
//     audit H-1). `alreadyEnrolled` selects which flow renders.
// On successful verify the server mints the step-up proof; we do a FULL
// navigation to /admin (not router.push) so the cookie is committed before the
// admin gate re-checks.

export function AdminMfaForm({ alreadyEnrolled = false }: { alreadyEnrolled?: boolean }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [startState, startAction, starting] = useActionState(
    startAdminMfaEnrollmentAction,
    undefined,
  );
  const [enrollVerifyState, enrollVerifyAction, enrollVerifying] = useActionState(
    verifyAdminMfaEnrollmentAction,
    undefined,
  );
  const [stepUpState, stepUpAction, steppingUp] = useActionState(
    verifyAdminMfaStepUpAction,
    undefined,
  );

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const verifyFormRef = useRef<HTMLFormElement>(null);
  const stepUpFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (enrollVerifyState?.verified || stepUpState?.verified) window.location.assign("/admin");
  }, [enrollVerifyState, stepUpState]);
  useEffect(() => {
    const err = enrollVerifyState?.error ?? stepUpState?.error;
    if (err) {
      toast.error(err);
      // A rejected code is never worth keeping around — clear it so the
      // retry starts from an empty field instead of the wrong digits.
      setCode("");
    }
  }, [enrollVerifyState, stepUpState]);

  // Rendered client-side from the otpauth:// URI — never round-trips through
  // the server as an image, so it adds no new trust boundary over the
  // manual-entry secret the server already sends.
  useEffect(() => {
    const uri = startState?.enrolled?.totpURI;
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    toDataURL(uri, { width: 200, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [startState?.enrolled?.totpURI]);

  const codeInput = (
    <OtpInput
      id="code"
      name="code"
      value={code}
      onChange={setCode}
      onComplete={() => {
        if (!enrollVerifying) verifyFormRef.current?.requestSubmit();
      }}
    />
  );

  // Enrolled already, but the session lacks a fresh step-up proof: prompt for
  // the current authenticator code (security audit H-1). No QR / secret here —
  // the secret was set at enrolment; this only re-proves possession.
  if (alreadyEnrolled) {
    return (
      <form ref={stepUpFormRef} action={stepUpAction} className="space-y-2">
        <p className="text-muted-foreground text-sm">{t("web.admin.mfa.stepUpPrompt")}</p>
        <Label htmlFor="code">{t("web.admin.mfa.codeLabel")}</Label>
        <OtpInput
          id="code"
          name="code"
          value={code}
          onChange={setCode}
          onComplete={() => {
            if (!steppingUp) stepUpFormRef.current?.requestSubmit();
          }}
        />
        {stepUpState?.error ? (
          <p role="alert" aria-live="polite" className="text-destructive text-sm">
            {stepUpState.error}
          </p>
        ) : null}
        <Button type="submit" disabled={code.length !== 6 || steppingUp}>
          {t("web.admin.mfa.verifyAndContinue")}
        </Button>
      </form>
    );
  }

  if (startState?.enrolled) {
    return (
      <div className="space-y-4">
        <p className="text-sm">{t("web.admin.mfa.scanInstructions")}</p>
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote image; next/image can't optimize it and doesn't need to.
          <img
            src={qrDataUrl}
            alt={t("web.admin.mfa.qrAlt")}
            width={200}
            height={200}
            className="border-border rounded border bg-white p-2"
          />
        ) : null}
        <details className="text-sm" open={!qrDataUrl}>
          <summary className="text-muted-foreground cursor-pointer">
            {t("web.admin.mfa.manualEntry")}
          </summary>
          <p className="bg-muted mt-2 rounded px-2 py-1 font-mono text-xs break-all">
            {startState.enrolled.secret}
          </p>
        </details>
        <form ref={verifyFormRef} action={enrollVerifyAction} className="space-y-2">
          <Label htmlFor="code">{t("web.admin.mfa.codeLabel")}</Label>
          {codeInput}
          {enrollVerifyState?.error ? (
            <p role="alert" aria-live="polite" className="text-destructive text-sm">
              {enrollVerifyState.error}
            </p>
          ) : null}
          <Button type="submit" disabled={code.length !== 6 || enrollVerifying}>
            {t("web.admin.mfa.verifyAndContinue")}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={startAction} className="space-y-2">
      <p className="text-muted-foreground text-sm">{t("web.admin.mfa.setupPrompt")}</p>
      <Button type="submit" disabled={starting}>
        {t("web.admin.mfa.setupButton")}
      </Button>
      {startState?.error ? (
        <p role="alert" aria-live="polite" className="text-destructive mt-2 text-sm">
          {startState.error}
        </p>
      ) : null}
    </form>
  );
}
