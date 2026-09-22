// LOCATION IS LOAD-BEARING: this app uses a `src/` directory (src/app), so
// Next.js only loads middleware from `src/middleware.ts`. A copy at the project
// root (apps/web/middleware.ts) is SILENTLY IGNORED — it never compiles into the
// middleware manifest and never runs, which leaves the CSP header, the
// better-auth session-cookie gate, auth redirects, and ?ref= attribution
// dormant in production. Do NOT move this back to the repo root.
// (See docs/security.md.)
import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except Next internals, static assets, the
    // uptime/liveness probe, and the Sentry tunnel. /api/health must stay
    // reachable even when auth is slow or down, otherwise external monitors
    // (UptimeRobot, Better Stack) flap on every auth-layer hiccup.
    // /monitoring is the Sentry tunnel (next.config tunnelRoute) — a
    // high-frequency first-party proxy that needs no auth/session work.
    // sw.js is the Web Push service worker (public/sw.js): a static asset that
    // needs no session work and must stay fetchable during registration and on
    // every browser-initiated update check.
    "/((?!api/health|api/csp-report|monitoring|sw.js|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
