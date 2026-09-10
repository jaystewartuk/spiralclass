"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { safeNextPath } from "@/lib/auth/safe-next";

// Google Sign-In button shared by /sign-in and /sign-up. Social sign-in is a
// full-page browser redirect (not a server action): better-auth bounces to
// Google, handles /api/auth/callback/google, sets the session cookie, then
// redirects to `callbackURL`. We send it to /auth/complete, which re-runs the
// role-aware routing (finalizeSignIn) the same way the email-OTP rail does.
//
// Rendered only when the server has both Google credentials configured
// (hasGoogleAuthCreds), so an unconfigured env never shows a dead button.
//
// `intent` (D-56) mirrors the email-OTP form's hidden field — "sign-up" is
// the only value that lets /auth/complete's finalizeSignIn lazy-create a
// Teacher for a brand-new identity. Carried through the OAuth round trip via
// the callbackURL query string since there's no form post to attach it to.
export function GoogleSignInButton({
  next,
  intent = "sign-in",
}: {
  next?: string;
  intent?: "sign-in" | "sign-up";
}) {
  const [pending, setPending] = useState(false);

  async function signInWithGoogle() {
    setPending(true);
    try {
      const safeNext = safeNextPath(next);
      const params = new URLSearchParams();
      if (safeNext) params.set("next", safeNext);
      if (intent === "sign-up") params.set("intent", "sign-up");
      const query = params.size ? `?${params.toString()}` : "";
      await authClient.signIn.social({
        provider: "google",
        callbackURL: `/auth/complete${query}`,
        // On cancel/OAuth error, land back on sign-in with a friendly message
        // rather than a raw better-auth error page.
        errorCallbackURL: "/sign-in?error=oauth",
      });
    } catch {
      // signIn.social redirects on success, so reaching here means the redirect
      // never started — re-enable the button so the user can retry.
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">o</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={signInWithGoogle}
        disabled={pending}
      >
        <GoogleG className="size-4" aria-hidden="true" />
        {pending ? "Conectando…" : "Continuar con Google"}
      </Button>
    </div>
  );
}

function GoogleG({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.09A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l4-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.76 0 3.34.61 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l4 3.09C6.23 6.87 8.88 4.76 12 4.76z"
      />
    </svg>
  );
}
