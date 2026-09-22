import { NextResponse } from "next/server";
import { requireOnboardedTeacher } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { hasGoogleCalendarCreds } from "@/lib/env";
import { buildGoogleAuthUrl, signOAuthState } from "@/lib/calendar/google/oauth";

// Kicks off the Google Calendar busy-import consent flow. Teacher-gated; 404s
// when the feature is dormant (no OAuth credentials configured).

export const dynamic = "force-dynamic";

export async function GET() {
  const teacher = await requireOnboardedTeacher();
  if (!hasGoogleCalendarCreds()) {
    return new NextResponse("Google Calendar integration is not configured.", { status: 404 });
  }
  const state = signOAuthState(teacher.id, serverEnv().SESSION_SECRET);
  return NextResponse.redirect(buildGoogleAuthUrl(state));
}
