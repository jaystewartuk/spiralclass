import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { finalizeSignIn } from "@/app/actions/session";
import { safeNextPath } from "@/lib/auth/safe-next";
import { publicUrl } from "@/lib/public-url";

// Post-OAuth landing (Google Sign-In). The email-OTP rail resolves its landing
// page inline in verifySignInCodeAction → finalizeSignIn, but a social sign-in
// is a browser redirect: better-auth handles /api/auth/callback/google, sets the
// session cookie, then redirects here (the `callbackURL` the button passes). So
// this route re-runs the SAME role-aware routing (teacher → dashboard/onboarding,
// student → my-classes, brand-new → onboarding) that the OTP path gets for free.
//
// Unlike the OTP server-action timing quirk (finalizeSignIn's own comment),
// getSession() here reads the cookie set by the PRIOR callback response, so the
// session is fully readable — no need to thread the user through by hand.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  // Threaded through by GoogleSignInButton's callbackURL query string (D-56) —
  // only "sign-up" may lazy-create a Teacher for a brand-new identity.
  const intent = req.nextUrl.searchParams.get("intent") === "sign-up" ? "sign-up" : "sign-in";

  const session = await auth.api.getSession({ headers: await headers() });
  const user = session?.user ? { id: session.user.id, email: session.user.email } : null;

  const dest = await finalizeSignIn(next, user, intent);
  // publicUrl, not req.nextUrl.origin — self-hosted, that origin is the
  // container's bind address (https://0.0.0.0:3000). See lib/public-url.ts.
  return NextResponse.redirect(publicUrl(dest));
}
