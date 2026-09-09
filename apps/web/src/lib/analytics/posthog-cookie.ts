// Server-side reader for posthog-js's own persistence cookie.
//
// Everywhere else in this codebase a server event that needs to line up with
// the browser's events gets the session id handed to it explicitly — the buy
// form and the lead form both post a hidden `posthogSessionId` field
// (currentSessionId() in posthog-browser.ts). That works for form submissions
// and not at all for a Server Component render: /b/[slug] emits
// `booking_page_viewed` during SSR, before any client code has run and with no
// form to carry the value.
//
// So read the cookie posthog-js already wrote on a previous request. This
// matters more than it sounds: without the browser's own `distinct_id`, a
// server-side pageview lands on a DIFFERENT person from the `$pageview`,
// `checkout_submitted` and session recording belonging to the very same visit,
// and every funnel spanning the two silently reports zero conversion.
//
// Cookie shape (posthog-js, default `cookie` persistence) — name is
// `ph_<projectToken>_posthog`, value is URI-encoded JSON:
//   { "distinct_id": "0190…", "$sesid": [1719…, "0190…", 1719…], … }
// `$sesid` is [lastActivityTs, sessionId, sessionStartTs].
//
// Everything here is best-effort: no cookie (first-ever request, ad-blocker,
// cookies declined) simply yields nulls, and the caller falls back.

export type PostHogClientIdentity = {
  distinctId: string | null;
  sessionId: string | null;
};

export const EMPTY_POSTHOG_IDENTITY: PostHogClientIdentity = {
  distinctId: null,
  sessionId: null,
};

/** posthog-js derives its cookie name from the project token. */
export function posthogCookieName(projectToken: string): string {
  return `ph_${projectToken}_posthog`;
}

export function parsePostHogCookie(raw: string | null | undefined): PostHogClientIdentity {
  if (!raw) return EMPTY_POSTHOG_IDENTITY;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not URI-encoded (or malformed) — fall through and try the raw value.
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_POSTHOG_IDENTITY;
    const obj = parsed as Record<string, unknown>;

    const distinctId = typeof obj.distinct_id === "string" ? obj.distinct_id : null;
    // $sesid is [lastActivityTs, sessionId, sessionStartTs]; only index 1 is
    // wanted, and only when it's actually a string.
    const sesid = obj.$sesid;
    const sessionId =
      Array.isArray(sesid) && typeof sesid[1] === "string" && sesid[1].length > 0 ? sesid[1] : null;

    return { distinctId, sessionId };
  } catch {
    return EMPTY_POSTHOG_IDENTITY;
  }
}

/**
 * The browsing visitor's PostHog identity for the current request, or nulls
 * when unavailable. Never throws — outside a request scope (tests, build-time
 * rendering) it resolves to nulls like any other miss.
 */
export async function currentPostHogIdentity(): Promise<PostHogClientIdentity> {
  const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!token) return EMPTY_POSTHOG_IDENTITY;
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    return parsePostHogCookie(store.get(posthogCookieName(token))?.value);
  } catch {
    return EMPTY_POSTHOG_IDENTITY;
  }
}
