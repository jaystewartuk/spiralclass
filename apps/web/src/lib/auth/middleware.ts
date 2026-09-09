import { getSessionCookie, getCookieCache } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { isSuperuser, serverEnv } from "@/lib/env";
import { buildCsp, cspHeaderName, generateNonce } from "@/lib/csp";
import { toPublicOrigin } from "@/lib/public-url";
import {
  newVisitorId,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/marketing/visitor-cookie";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  attributionFromRequest,
  hasAttribution,
  serializeAttribution,
} from "@/lib/analytics/attribution";
import {
  isMaintenanceMode,
  isMaintenanceAllowlisted,
  maintenanceBypassToken,
  maintenanceMessage,
  hasMaintenanceBypassCookie,
  hasMaintenanceBypassQuery,
  MAINTENANCE_BYPASS_COOKIE,
} from "@/lib/maintenance";
import {
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_QUERY_PARAM,
  normalizeReferralCode,
} from "@/lib/subscriptions/referral";

// Called from the root middleware on every request. Optimistic, edge-safe
// auth gate on better-auth's session cookie (D-40 migration plan): presence-
// only, no DB round trip. The authoritative check is always
// auth.api.getSession() at the page/server-action layer, which fails closed —
// this only decides whether to bounce a request before it renders.
export async function updateSession(request: NextRequest) {
  // Per-request CSP nonce. Two things have to carry it:
  //  - `x-nonce` on the request, so Server Components / <Script> can read it via
  //    headers().get("x-nonce").
  //  - the `Content-Security-Policy` REQUEST header, which is how Next.js
  //    auto-stamps the nonce onto its own inline bootstrap <script> tags. Next
  //    reads the nonce from this specific header on the request — `x-nonce`
  //    alone does NOT trigger it. Without this line Next's inline scripts get no
  //    nonce and are blocked the moment CSP_ENFORCE is on. Always use the
  //    enforcing header name here (not the report-only variant) regardless of
  //    mode — Next only looks for "Content-Security-Policy" to find the nonce.
  const nonce = generateNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Forward the pathname so Server Components / layouts can read it via
  // headers().get("x-pathname") — Next doesn't expose the request path to a
  // layout otherwise.
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("Content-Security-Policy", buildCsp(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  const path = request.nextUrl.pathname;

  // Maintenance mode (D-76). A single env flag (MAINTENANCE_MODE) takes both
  // apps offline for a planned window. Short-circuit here — before the auth
  // gate — so every page/API hit gets the wall, EXCEPT the handful of paths
  // that must stay reachable (health check, the mobile config the app polls to
  // learn it's in maintenance, telemetry sinks, and the wall page itself). An
  // operator punches through with ?maintenance_bypass=<MAINTENANCE_BYPASS_TOKEN>,
  // which sets a cookie so the rest of their navigation stays live while
  // everyone else sees the wall — letting them verify the fix before flipping
  // maintenance back off.
  if (isMaintenanceMode()) {
    const bypassingViaQuery = hasMaintenanceBypassQuery(request);
    const bypassing = bypassingViaQuery || hasMaintenanceBypassCookie(request);

    if (bypassingViaQuery) {
      // Persist the bypass so the operator's subsequent navigation stays live
      // without re-appending the token to every URL.
      response.cookies.set(MAINTENANCE_BYPASS_COOKIE, maintenanceBypassToken()!, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 8,
      });
    }

    if (!bypassing && !isMaintenanceAllowlisted(path)) {
      // API callers get a clean 503 JSON so the client can surface maintenance
      // instead of a parse error.
      if (path.startsWith("/api/")) {
        return NextResponse.json(
          {
            ok: false,
            reason: "maintenance",
            message: maintenanceMessage() ?? "Service temporarily unavailable",
          },
          { status: 503, headers: { "Retry-After": "3600" } },
        );
      }
      // Page requests are rewritten (not redirected) to the localized wall,
      // keeping the URL and returning a 503 so crawlers/monitors read it as
      // temporary. Reuse this request's nonce'd headers so the wall renders
      // CSP-clean even under CSP_ENFORCE.
      const url = request.nextUrl.clone();
      url.pathname = "/maintenance";
      url.search = "";
      const wall = NextResponse.rewrite(url, {
        status: 503,
        request: { headers: requestHeaders },
      });
      wall.headers.set("Retry-After", "3600");
      wall.headers.set(cspHeaderName(), buildCsp(nonce));
      return wall;
    }
  }

  const isAuthPath = path.startsWith("/sign-in") || path.startsWith("/sign-up");

  // The (app) route group — every segment behind requireTeacher() in its
  // layout. That layout guard is the authoritative check; this list is
  // defense in depth so an unauthenticated hit bounces before rendering.
  const isTeacherPath =
    path.startsWith("/dashboard") ||
    path.startsWith("/onboarding") ||
    path.startsWith("/settings") ||
    path.startsWith("/payments") ||
    path.startsWith("/notifications");
  const isStudentPath = path.startsWith("/my-classes");
  const isAdminPath = path.startsWith("/admin");

  const hasSession = Boolean(getSessionCookie(request));

  if ((isTeacherPath || isStudentPath || isAdminPath) && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = isStudentPath ? "/" : "/sign-in";
    if (!isStudentPath) url.searchParams.set("next", path);
    // toPublicOrigin, not the cloned origin — self-hosted, nextUrl.origin is the
    // container's bind address (https://0.0.0.0:3000). See lib/public-url.ts.
    return NextResponse.redirect(toPublicOrigin(url));
  }

  // /admin authorization is enforced authoritatively at the page layer by
  // requireAdmin() (src/lib/admin.ts), which honours the DB role model
  // (admin_users) AND the env bootstrap allowlist, plus the mandatory
  // twoFactorEnabled gate. Middleware only checks session presence — any
  // *authenticated* request is allowed through the /admin matcher, and
  // requireAdmin() fails closed for non-admins. The !hasSession case is
  // already handled above.

  // On /sign-in or /sign-up redirect an authenticated user straight to
  // /dashboard, or /admin for superusers. The superuser destination is read
  // from the signed cookie-cache (best-effort, no DB hit); a cache
  // miss/expiry just falls back to /dashboard rather than blocking anything.
  if (isAuthPath && hasSession) {
    const url = request.nextUrl.clone();
    // getCookieCache throws BetterAuthError if BETTER_AUTH_SECRET is unset —
    // a misconfigured deploy env, not a user-facing condition. Degrade to the
    // non-superuser default (worst case: a superuser lands on /dashboard
    // instead of /admin, one extra click) rather than 500ing every
    // already-signed-in visit to /sign-in.
    const secret = serverEnv().BETTER_AUTH_SECRET;
    const cache = secret ? await getCookieCache(request, { secret }) : null;
    url.pathname = isSuperuser(cache?.user?.email) ? "/admin" : "/dashboard";
    url.search = "";
    return NextResponse.redirect(toPublicOrigin(url));
  }

  // Lightweight ambassador attribution: stamp a `?ref=CODE` into a first-party
  // cookie so it survives until the teacher row is lazy-created (lib/auth.ts).
  // Only set once (don't overwrite an earlier attribution) and only when the
  // visitor isn't already signed in.
  const refParam = normalizeReferralCode(request.nextUrl.searchParams.get(REFERRAL_QUERY_PARAM));
  if (refParam && !request.cookies.get(REFERRAL_COOKIE) && !hasSession) {
    response.cookies.set(REFERRAL_COOKIE, refParam, {
      maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  }

  // Student-side marketing attribution — deliberately a SEPARATE cookie from
  // ap_ref above, which attributes teacher signups to an ambassador and means
  // something entirely different. Stamped first-touch-wins so the Facebook
  // group that actually won a student keeps the credit when she returns later
  // by bookmark. See lib/analytics/attribution.ts for why posthog-js's own
  // $initial_utm_* can't answer this.
  if (!request.cookies.get(ATTRIBUTION_COOKIE)) {
    const attribution = attributionFromRequest({
      searchParams: request.nextUrl.searchParams,
      referer: request.headers.get("referer"),
      selfOrigin: request.nextUrl.origin,
    });
    if (hasAttribution(attribution)) {
      response.cookies.set(ATTRIBUTION_COOKIE, serializeAttribution(attribution), {
        maxAge: ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
        // Read only by server code (lib/analytics/attribution.ts consumers);
        // the browser SDK has its own, separate notion of UTMs.
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
    }
  }

  // First-party visitor id for the acquisition funnel (D-125). Minted here
  // (the only place a Server Component render can be given a cookie) and never
  // stored raw — lib/marketing/visitor.ts HMACs it before it reaches the
  // ledger, so what we keep identifies a browser to this teacher's own funnel
  // and to nothing else. No IP, no user agent, no referrer path.
  if (!request.cookies.get(VISITOR_COOKIE)) {
    response.cookies.set(VISITOR_COOKIE, newVisitorId(), {
      maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  }

  // Attach the CSP (report-only by default; enforcing when CSP_ENFORCE is set)
  // carrying this request's nonce. Only the non-redirect document responses
  // need it — redirects render no nonce'd markup.
  response.headers.set(cspHeaderName(), buildCsp(nonce));

  return response;
}
