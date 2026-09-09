import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv, hasGoogleCalendarCreds } from "@/lib/env";
import {
  exchangeCodeForTokens,
  emailFromIdToken,
  verifyOAuthState,
} from "@/lib/calendar/google/oauth";
import { saveGoogleConnection } from "@/lib/calendar/google/connection";
import { syncTeacherBusy } from "@/lib/calendar/google/sync";

// OAuth redirect target. Verifies our signed state (CSRF + teacher binding),
// exchanges the code for tokens, persists the connection, and kicks off an
// immediate first sync. Always lands the teacher back on the calendar settings
// page with a status query param.

export const dynamic = "force-dynamic";

function settingsRedirect(appUrl: string, status: string): NextResponse {
  const base = appUrl.replace(/\/$/, "");
  return NextResponse.redirect(`${base}/settings/calendar?google=${status}`);
}

export async function GET(req: NextRequest) {
  const appUrl = serverEnv().APP_URL;
  if (!hasGoogleCalendarCreds()) {
    return new NextResponse("Google Calendar integration is not configured.", { status: 404 });
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    // Teacher declined consent, or Google returned an error.
    return settingsRedirect(appUrl, "denied");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return settingsRedirect(appUrl, "error");

  const verified = verifyOAuthState(state, serverEnv().SESSION_SECRET);
  if (!verified.ok) return settingsRedirect(appUrl, "error");

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveGoogleConnection({
      teacherId: verified.teacherId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
      googleEmail: emailFromIdToken(tokens.idToken),
    });
    // Best-effort first sync so the teacher sees their busy times reflected
    // immediately; the cron keeps it fresh afterwards.
    await syncTeacherBusy(verified.teacherId);
    return settingsRedirect(appUrl, "connected");
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: "google-calendar-callback" } });
    return settingsRedirect(appUrl, "error");
  }
}
