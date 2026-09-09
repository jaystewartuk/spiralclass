// Single source of truth for the Content-Security-Policy directive.
//
// script-src is nonce-based: middleware mints a per-request nonce, forwards it
// to the app on the `x-nonce` request header (Next.js then stamps it onto its
// own bootstrap <script> tags automatically, and the <Script> component / our
// own inline scripts can read it via `headers().get("x-nonce")`), and sets the
// CSP response header containing `'nonce-<value>'`. This replaces the blanket
// `'unsafe-inline'` on scripts — an injected inline <script> without the nonce
// won't execute under enforcement.
//
// Enforcement: ON by default in production (and on Vercel preview/preview, which
// build with NODE_ENV=production — deliberately, so preview catches a missing
// directive before prod). Report-only everywhere else (dev/test) so HMR + dev
// tooling inline scripts aren't blocked. `CSP_ENFORCE` is an explicit override in
// *either* direction: set it to "1"/"true" to force enforcement, or "0"/"false"
// to fall back to report-only — the instant, per-environment kill-switch if a
// directive turns out to block something in prod. Violations are POSTed to the
// `report-uri` sink (/api/csp-report) in both modes, so the report-only→enforce
// transition stays observable.
//
// style-src deliberately keeps `'unsafe-inline'`: Tailwind/shadcn emit runtime
// inline styles and there is no style-nonce plumbing; tightening that is a
// separate effort and is not security-critical the way script injection is.

export function cspEnforced(): boolean {
  const flag = process.env.CSP_ENFORCE;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

// Where browsers POST CSP violation reports. Same-origin API route, exempt from
// the middleware matcher + auth (the browser sends it without a session).
export const CSP_REPORT_PATH = "/api/csp-report";

export function cspHeaderName(): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return cspEnforced() ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

// MAINTENANCE RULE (read before adding any third party): CSP is *enforced* in
// production (CSP_ENFORCE=1), so a browser-reachable host missing from the right
// directive is silently blocked in prod — that is exactly how the in-class video
// call shipped broken (LiveKit's signaling wasn't in connect-src). Whenever you
// add a client-side integration, add its host(s) to the directive below AND to
// the matching expected-allowlist set in `tests/lib/csp.test.ts`, in the same
// change. That test asserts each directive *exactly*, so a forgotten entry (or an
// unasserted new one) fails CI instead of breaking a feature in front of a user.
// Reminder on scope: connect-src governs only browser-initiated fetch / XHR /
// WebSocket / EventSource — server-side calls (Anthropic, Resend, the
// Stripe secret API, Inngest serve) are NOT subject to CSP and don't need listing
// for their server use; a few are listed defensively only.
export function buildCsp(nonce: string): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      // Explicit third-party script hosts, still allowed alongside the nonce.
      "https://js.stripe.com",
      // Connect embedded components (the teacher's Stripe onboarding) load
      // their own script from a SEPARATE host to js.stripe.com. Without it the
      // browser blocks the script, @stripe/connect-js throws "Failed to load
      // Connect.js", and the onboarding card renders EMPTY — no error, no
      // fallback button, just nothing. Measured on production 2026-08-30.
      //
      // Worse than a blank card: the component retries, and each retry called
      // the server action that creates a connected account, which produced
      // FOURTEEN live Stripe accounts for one teacher. The idempotency key
      // added alongside this stops the duplicates; this stops the retries.
      "https://connect-js.stripe.com",
      "https://*.posthog.com",
      "https://*.sentry.io",
    ],
    // fonts.googleapis.com serves the Google Fonts @font-face stylesheet linked
    // by server-rendered HTML routes (e.g. the email-unsubscribe landing page);
    // the actual woff2 files it points at come from fonts.gstatic.com (font-src
    // below). The app's own pages self-host fonts via next/font and don't rely on
    // this — it's for the standalone HTML routes.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // <video> playback (D-73): the teacher intro video is served from the public
    // R2 bucket (an https host), and the booking-page editor previews an
    // in-browser recording from a `blob:` object URL before upload. Mirrors the
    // broad `https:` in img-src (the R2 public host varies per environment) so a
    // recorded/hosted video is never silently blocked under enforcement.
    "media-src": ["'self'", "blob:", "https:"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    // Without an explicit worker-src, browsers fall back to script-src for
    // `new Worker(...)` — which doesn't include blob:, so it silently blocks
    // PostHog's session-recording compression worker (posthog-js spins one up
    // from a blob: URL) on every page, app-wide since session_recording was
    // turned on (posthog-browser.ts). Not related to any domain — this was
    // always going to surface once CSP enforcement caught up with it.
    "worker-src": ["'self'", "blob:"],
    "connect-src": [
      "'self'",
      "https://api.stripe.com",
      "https://*.sentry.io",
      "https://*.posthog.com",
      "https://api.resend.com",
      // Inngest serve and event ingestion.
      "https://api.inngest.com",
      "https://inn.gs",
      // LiveKit (in-class video, D-16): the client fetches region settings and
      // validates over https, then opens the signaling socket over wss. LiveKit
      // Cloud uses per-project + regional subdomains under livekit.cloud, so a
      // wildcard covers the project URL and whichever region it's steered to.
      // (WebRTC media itself is ICE/STUN/TURN, not governed by connect-src.)
      "https://*.livekit.cloud",
      "wss://*.livekit.cloud",
      // Self-hosted LiveKit (docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md,
      // 2026-07-21): preview points here now; production still uses Cloud
      // above, so both stay listed rather than making this env-conditional.
      "https://livekit.spiralclass.com",
      "wss://livekit.spiralclass.com",
      // Deepgram is deliberately ABSENT. Captions were client-streamed under
      // D-27 and the teacher's browser held a wss socket to api.deepgram.com;
      // D-106 moved that to the server-side Agent, and the last surface still
      // publishing from the browser is gone. The only Deepgram call left is a
      // server-side batch fetch (lib/transcription/deepgram.ts), which no
      // connect-src governs. Do not re-add it without a browser socket to
      // justify it — tests/lib/csp.test.ts pins this list exactly.
      // Intro-video upload (D-73): the booking-page editor uploads the video
      // straight to R2 via a presigned PUT (bypassing the 25 MB Server-Action
      // body limit), so the browser opens a direct connection to the R2 S3 API
      // host. The wildcard covers the per-account subdomain.
      "https://*.r2.cloudflarestorage.com",
    ],
    "frame-src": [
      "'self'",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
      // The embedded onboarding UI itself renders in an iframe from this host.
      // Allowing the script without the frame gets you a loaded component that
      // still shows nothing.
      "https://connect-js.stripe.com",
    ],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    // Surface violations to the same-origin sink so a missing directive is
    // visible in logs during (and after) the report-only→enforce rollout rather
    // than failing silently in a browser. `report-uri` is the broadly-supported
    // form; modern browsers also honour Reporting-Endpoints/report-to, deferred.
    "report-uri": [CSP_REPORT_PATH],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

// Edge-runtime-safe random nonce (base64). `crypto` is the Web Crypto global in
// Next middleware; avoid Node Buffer so it works on the edge.
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
