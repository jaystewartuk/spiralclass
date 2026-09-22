import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { auth } from "@/lib/auth/server";
import { resolveNotificationSettingsLink } from "@/lib/notifications/settings-link";
import { getT } from "@/lib/i18n";

// Email-only per-recipient token URLs — never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Every notification email carries this link. It's a *thin* server hop:
// verify the token and resolve the recipient's identity here (no session
// required — the signed token is the proof), then land the visitor in the
// right place based on the one session (if any) on this device:
//   - already signed in AS this account: straight to their settings page.
//   - anyone else (signed in as someone else, or not at all): /sign-in,
//     prefilled with the recipient's email and a "different account" notice.
// See lib/notifications/settings-link.ts for the identity resolution.
export default async function NotificationSettingsLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const env = serverEnv();
  const result = await resolveNotificationSettingsLink(
    { prisma, secret: env.SESSION_SECRET },
    token,
  );

  if (!result.ok) {
    const t = await getT();
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <Heading level={2} as="h1">
          {t("web.notifSettingsLink.invalidTitle")}
        </Heading>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("web.notifSettingsLink.invalidBody")}
        </p>
      </main>
    );
  }

  const settingsPath =
    result.target.role === "teacher" ? "/settings/notifications" : "/my-classes/account";

  const session = await auth.api.getSession({ headers: await headers() });
  if (result.target.accountId && session?.user.id === result.target.accountId) {
    redirect(settingsPath);
  }

  const search = new URLSearchParams({
    next: settingsPath,
    notice: "different-account",
    email: result.target.email,
  });
  redirect(`/sign-in?${search.toString()}`);
}
