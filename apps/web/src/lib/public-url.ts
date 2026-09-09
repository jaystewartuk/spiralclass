import { serverEnv } from "@/lib/env";

// Absolute redirect targets must be resolved against the deployment's PUBLIC
// origin (APP_URL), never against the incoming request's own origin.
//
// WHY (this is a real outage, not a style rule): self-hosted preview runs Next's
// standalone server (Dockerfile → `node apps/web/server.js`). That entrypoint
// binds with `HOSTNAME || '0.0.0.0'` and `PORT`, and Next builds every request's
// URL from those BIND values rather than from the proxied `Host` header —
// next-server.js's attachRequestMeta:
//
//   const protocol = req.headers['x-forwarded-proto']?.includes('https') ? 'https' : 'http';
//   const initUrl = this.fetchHostname && this.port
//     ? `${protocol}://${this.fetchHostname}:${this.port}${req.url}`
//     : ...
//
// It takes the *protocol* from the proxy but the *host* from the socket bind, so
// behind Fly (force_https → `x-forwarded-proto: https`) `request.nextUrl.origin`
// is literally `https://0.0.0.0:3000`. Anything derived from it ships that
// unreachable origin to the browser in `Location:`. `experimental.trustHostHeader`
// does NOT help — that branch is only reached when hostname/port are unset, and
// the standalone entrypoint always sets them.
//
// On Vercel the same code happens to work (no hostname/port passed), which is why
// this only ever broke self-hosted.
//
// APP_URL is the canonical public origin and is already what the other redirecting
// routes build against (app/r/ml, app/api/stripe/connect/return,
// app/api/calendar/google/callback). It also can't be poisoned by a spoofed Host
// header the way header-derived origins can.

/** Resolve an internal path (`/dashboard`, `/sign-in?next=/x`) against APP_URL. */
export function publicUrl(path: string): URL {
  return new URL(path, serverEnv().APP_URL);
}

/**
 * Re-base a URL derived from the request (e.g. `request.nextUrl.clone()`) onto
 * the public origin, keeping its path and query.
 */
export function toPublicOrigin(url: URL): URL {
  return publicUrl(`${url.pathname}${url.search}`);
}
