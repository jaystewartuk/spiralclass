"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { useT } from "@/components/locale-provider";

// Google Sign-In connection status + connect/reconnect action, shown on the
// account settings page (teacher and student twins render this same card).
//
// Why this exists: changing the sign-in email disconnects any linked Google
// account (lib/auth/identity-change.ts) — the OLD Google identity must never
// keep working after the email moves. This card is how a teacher/student
// re-establishes Google Sign-In afterward, and it can only ever succeed with
// a Google account matching their CURRENT email: better-auth's own
// /link-social flow rejects a mismatched email server-side (unless
// account.accountLinking.allowDifferentEmails is turned on, which this app
// deliberately never does — see lib/auth/server.ts). That's what makes this
// a real "require re-authentication with the new Google account" step, not
// just cosmetic — there's no way to link the wrong Google account here.
export function GoogleConnectionCard({
  linked,
  redirectTo,
}: {
  linked: boolean;
  redirectTo: string;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);

  async function connect() {
    setPending(true);
    try {
      await authClient.linkSocial({
        provider: "google",
        callbackURL: `${redirectTo}?google=linked`,
        errorCallbackURL: `${redirectTo}?google=error`,
      });
    } catch {
      // linkSocial redirects on success; reaching here means the redirect
      // never started — re-enable the button so the user can retry.
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm">
        {linked
          ? t("web.settings.account.googleLinked")
          : t("web.settings.account.googleNotLinked")}
      </p>
      <Button type="button" variant="outline" onClick={connect} disabled={pending}>
        {pending
          ? t("web.settings.account.googleConnecting")
          : linked
            ? t("web.settings.account.googleReconnect")
            : t("web.settings.account.googleConnect")}
      </Button>
    </div>
  );
}
