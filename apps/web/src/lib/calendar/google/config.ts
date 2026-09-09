import { serverEnv } from "@/lib/env";

// Google Calendar busy-import configuration. Read-only scope only — the
// integration never writes to the teacher's Google calendar (pushing
// SpiralClass classes out is the Phase 2 iCal feed's job). `openid email` lets
// us show "Connected as <email>".

export const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freeBusy";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

// Field-encryption column id for the stored refresh token (HKDF info param).
export const GOOGLE_REFRESH_TOKEN_COLUMN = "googleCalendarRefreshToken";

/** The OAuth redirect URI, derived from APP_URL. Must match the registered URI. */
export function googleRedirectUri(): string {
  return `${serverEnv().APP_URL.replace(/\/$/, "")}/api/calendar/google/callback`;
}
