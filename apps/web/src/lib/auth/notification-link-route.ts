import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { isSameOrigin } from "@/lib/auth/csrf";
import type { NotificationLinkKind } from "@/lib/auth/notification-link";
import { redeemNotificationLink } from "@/lib/auth/notification-link-redeem";
import {
  notificationLinkConfirmResponse,
  notificationLinkExpiredResponse,
} from "@/lib/auth/notification-link-pages";

type Ctx = { params: Promise<{ token: string }> };

// The GET/POST pair behind `/r/re/<token>` (rebook after a cancellation) and
// `/r/ml/<token>` (open the portal after a first payment). Both routes are the
// same shape and differ only in the kind of link they accept, so they share
// one implementation rather than two copies that can drift.
export function notificationLinkRoute(kind: NotificationLinkKind) {
  async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
    const { token } = await ctx.params;
    return notificationLinkConfirmResponse(kind, token);
  }

  async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
    // The form on the GET page posts back to this same origin. Anything else
    // is not that form.
    if (!isSameOrigin(req)) return notificationLinkExpiredResponse(kind, 403);

    const { token } = await ctx.params;
    const outcome = await redeemNotificationLink({ kind, token, headers: req.headers });
    const appUrl = serverEnv().APP_URL;

    switch (outcome.code) {
      case "signed-in":
        return NextResponse.redirect(new URL(outcome.redirectTo, appUrl), { status: 303 });
      case "sign-in":
        return NextResponse.redirect(new URL("/sign-in", appUrl), { status: 303 });
      case "unavailable":
        return new NextResponse("sign-in link unavailable", { status: 503 });
      case "expired":
        return notificationLinkExpiredResponse(kind);
    }
  }

  return { GET, POST };
}
