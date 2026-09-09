"use client";

import { requestSignInCodeAction } from "@/app/actions/auth";
import { ResendCodeButton } from "@/app/(auth)/resend-code-button";

// Lets a student re-trigger the sign-in code from the post-checkout page —
// the code is auto-sent on first payment, but emails get lost. Reuses the
// standard passwordless sign-in action (the student already has an account
// row from checkout, so it sends) and the shared resend-cooldown affordance.
export function ResendSignInLink({ email }: { email: string }) {
  return <ResendCodeButton action={requestSignInCodeAction} email={email} />;
}
