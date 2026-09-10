"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { otpResendCooldownSeconds } from "@spiralclass/shared";
import type { ActionState } from "@/app/actions/auth";

// "Resend code" affordance for the OTP check-email step — shared by sign-in,
// sign-up, and the post-checkout resend link. Client-side cooldown
// (packages/shared/src/otp-resend.ts) escalates on each resend to discourage
// accidental double-taps; the real cap is the action's own per-IP/per-email
// rate limiting (app/actions/auth.ts), whose retryAfterMs — when present —
// extends the countdown to match the server's actual remaining window.
export function ResendCodeButton({
  action,
  email,
  extraFields,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  email: string;
  // Extra hidden fields the bound action needs (e.g. sign-up's `name`).
  extraFields?: Record<string, string>;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, undefined);
  const resendCount = useRef(0);
  const lastHandledState = useRef<ActionState>(undefined);
  const [readyAt, setReadyAt] = useState(() => Date.now() + otpResendCooldownSeconds(0) * 1000);
  const [secondsLeft, setSecondsLeft] = useState(() => Math.ceil((readyAt - Date.now()) / 1000));

  useEffect(() => {
    // Recompute immediately (not just on the next tick) so a fresh cooldown —
    // set right after a resend — disables the button the same instant instead
    // of leaving it clickable for up to 1s until the interval catches up.
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((readyAt - Date.now()) / 1000)));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [readyAt]);

  useEffect(() => {
    if (!state || state === lastHandledState.current) return;
    lastHandledState.current = state;
    if (state.ok) {
      resendCount.current += 1;
      setReadyAt(Date.now() + otpResendCooldownSeconds(resendCount.current) * 1000);
    } else if (state.retryAfterMs) {
      // Server throttled us for longer than our own cooldown (e.g. another
      // tab/device already used up the window) — extend to match.
      setReadyAt((prev) => Math.max(prev, Date.now() + state.retryAfterMs!));
    }
  }, [state]);

  const disabled = pending || secondsLeft > 0;

  return (
    <form action={formAction}>
      <input type="hidden" name="email" value={email} />
      {Object.entries(extraFields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant="outline" size="sm" disabled={disabled}>
        {pending
          ? t("web.signIn.sending")
          : secondsLeft > 0
            ? t("web.resend.cooldown", { seconds: secondsLeft })
            : t("web.resend.cta")}
      </Button>
      {state?.ok && secondsLeft > 0 && (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          {t("web.resend.sent")}
        </p>
      )}
      {state?.error && (
        <p role="alert" aria-live="polite" className="mt-1 text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
