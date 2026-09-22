import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp, cspEnforced, cspHeaderName, generateNonce } from "@/lib/csp";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Pull the source tokens of one directive out of the built CSP string, e.g.
// directiveTokens(csp, "connect-src") -> ["'self'", "https://api.stripe.com", …].
function directiveTokens(csp: string, name: string): string[] {
  const d = csp.split("; ").find((s) => s.startsWith(`${name} `));
  return d ? d.slice(name.length + 1).split(" ") : [];
}

describe("buildCsp", () => {
  it("embeds the per-request nonce in script-src and drops unsafe-inline there", () => {
    const csp = buildCsp("ABC123==");
    expect(csp).toContain("script-src");
    expect(csp).toContain("'nonce-ABC123=='");
    // script-src must NOT fall back to unsafe-inline once nonce-based.
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // explicit third-party script hosts remain allowed alongside the nonce.
    expect(scriptSrc).toContain("https://js.stripe.com");
  });

  it("keeps unsafe-inline on style-src (Tailwind runtime styles)", () => {
    const styleSrc = buildCsp("n")
      .split("; ")
      .find((d) => d.startsWith("style-src "))!;
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("locks down object-src and frame-ancestors", () => {
    const csp = buildCsp("n");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("points report-uri at the same-origin violation sink", () => {
    expect(buildCsp("n")).toContain("report-uri /api/csp-report");
  });
});

// GUARDRAIL — keep in lockstep with the directives in `src/lib/csp.ts`.
//
// CSP is enforced in production (CSP_ENFORCE=1). A browser-reachable host that is
// missing from the right directive is silently blocked in prod — which is exactly
// how the in-class video call shipped broken: LiveKit's signaling endpoints
// weren't in connect-src, so room.connect() went connecting -> disconnected for
// every user. These tests assert each network directive *exactly* (set equality),
// so adding a client integration without allow-listing it — or removing a host a
// feature depends on — fails here instead of in front of a user. When you add a
// browser-facing third party, add its host(s) to lib/csp.ts AND to the matching
// set below, in the same change.
describe("buildCsp third-party allowlists are complete and asserted", () => {
  // buildCsp is environment-invariant (the old Vercel Live off-production block
  // was removed with the D-89 decommission), so these directive sets are the
  // whole allowlist on every deployment.
  it("connect-src matches the documented host allowlist exactly", () => {
    // Browser-initiated network destinations (fetch / XHR / WebSocket). Inline
    // notes say what each is for; entries marked (defensive) are normally only
    // hit server-side and could be dropped, but are listed to be safe.
    const EXPECTED_CONNECT_SRC = new Set([
      "'self'", //                     app APIs + PostHog /ingest proxy + Sentry /monitoring tunnel
      "https://api.stripe.com", //     Stripe.js
      "https://*.sentry.io", //        Sentry direct ingest (tunnel is same-origin; this is a fallback)
      "https://*.posthog.com", //      PostHog non-proxied assets / feature-flag config
      "https://api.resend.com", //     (defensive — Resend send is server-side)
      "https://api.inngest.com", //    (defensive — Inngest serve is server-side)
      "https://inn.gs", //             (defensive — Inngest event ingest is server-side)
      "https://*.livekit.cloud", //    LiveKit signaling: region settings + validate (https)
      "wss://*.livekit.cloud", //      LiveKit signaling socket (wss)
      "https://livekit.spiralclass.com", // Self-hosted LiveKit (preview, 2026-07-21)
      "wss://livekit.spiralclass.com", //   Self-hosted LiveKit signaling socket (preview)
      "https://*.r2.cloudflarestorage.com", // intro-video presigned PUT (browser→R2, D-73)
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "connect-src"))).toEqual(EXPECTED_CONNECT_SRC);
  });

  it("script-src matches self + nonce + the third-party script hosts exactly", () => {
    const EXPECTED_SCRIPT_SRC = new Set([
      "'self'",
      "'nonce-n'",
      "https://js.stripe.com", //  Stripe.js
      // Connect embedded onboarding. Its absence rendered the teacher's Stripe
      // card EMPTY on production — no error surfaced to her, and the component's
      // retries minted 14 connected accounts for one teacher.
      "https://connect-js.stripe.com",
      "https://*.posthog.com", //  posthog-js loader
      "https://*.sentry.io", //    Sentry loader (if used)
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "script-src"))).toEqual(EXPECTED_SCRIPT_SRC);
  });

  it("frame-src matches the documented embed allowlist exactly", () => {
    const EXPECTED_FRAME_SRC = new Set([
      "'self'",
      "https://js.stripe.com", //     Stripe Elements iframe
      "https://hooks.stripe.com", //  Stripe 3DS / redirect iframe
      // The embedded onboarding UI renders in an iframe from this host —
      // allowing the script without the frame still shows nothing.
      "https://connect-js.stripe.com",
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "frame-src"))).toEqual(EXPECTED_FRAME_SRC);
  });

  it("media-src matches the documented allowlist exactly (intro-video playback)", () => {
    // <video> sources: the public R2 host (broad https:, host varies per env,
    // mirroring img-src) plus blob: for the booking-page recorder's local
    // preview before upload. See D-73.
    const EXPECTED_MEDIA_SRC = new Set([
      "'self'",
      "blob:", //   in-browser recording preview (URL.createObjectURL)
      "https:", //  R2 public host serving the stored intro video
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "media-src"))).toEqual(EXPECTED_MEDIA_SRC);
  });

  it("style-src matches the documented allowlist exactly (incl. Google Fonts CSS)", () => {
    const EXPECTED_STYLE_SRC = new Set([
      "'self'",
      "'unsafe-inline'", //              Tailwind/shadcn runtime inline styles
      "https://fonts.googleapis.com", // Google Fonts @font-face stylesheet (HTML routes)
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "style-src"))).toEqual(EXPECTED_STYLE_SRC);
  });

  it("font-src matches the documented allowlist exactly (incl. Google Fonts files)", () => {
    const EXPECTED_FONT_SRC = new Set([
      "'self'",
      "data:",
      "https://fonts.gstatic.com", // woff2 files the Google Fonts CSS points at
    ]);
    expect(new Set(directiveTokens(buildCsp("n"), "font-src"))).toEqual(EXPECTED_FONT_SRC);
  });

  it("worker-src allows blob: (posthog-js's session-recording compression worker)", () => {
    const EXPECTED_WORKER_SRC = new Set(["'self'", "blob:"]);
    expect(new Set(directiveTokens(buildCsp("n"), "worker-src"))).toEqual(EXPECTED_WORKER_SRC);
  });
});

// The Vercel Live toolbar hosts (vercel.live / *.pusher.com / assets.vercel.com)
// were removed from the CSP with the D-89 Vercel decommission — the toolbar only
// existed on Vercel preview deploys. Lock in that no Vercel host survives.
describe("no Vercel host in the CSP (post-D-89)", () => {
  it("never emits vercel.live / pusher.com / assets.vercel.com", () => {
    const csp = buildCsp("n");
    expect(csp).not.toContain("vercel.live");
    expect(csp).not.toContain("pusher.com");
    expect(csp).not.toContain("assets.vercel.com");
  });
});

describe("cspEnforced / cspHeaderName", () => {
  it("defaults to report-only in non-production (dev/test) when CSP_ENFORCE is unset", () => {
    vi.stubEnv("CSP_ENFORCE", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(cspEnforced()).toBe(false);
    expect(cspHeaderName()).toBe("Content-Security-Policy-Report-Only");
  });

  it("enforces by default in production when CSP_ENFORCE is unset", () => {
    vi.stubEnv("CSP_ENFORCE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(cspEnforced()).toBe(true);
    expect(cspHeaderName()).toBe("Content-Security-Policy");
  });

  it("enforces when CSP_ENFORCE=1 or true (override, any environment)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CSP_ENFORCE", "1");
    expect(cspEnforced()).toBe(true);
    expect(cspHeaderName()).toBe("Content-Security-Policy");
    vi.stubEnv("CSP_ENFORCE", "true");
    expect(cspHeaderName()).toBe("Content-Security-Policy");
  });

  it("CSP_ENFORCE=0/false is the kill-switch — forces report-only even in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CSP_ENFORCE", "0");
    expect(cspEnforced()).toBe(false);
    vi.stubEnv("CSP_ENFORCE", "false");
    expect(cspEnforced()).toBe(false);
    expect(cspHeaderName()).toBe("Content-Security-Policy-Report-Only");
  });
});

describe("generateNonce", () => {
  it("returns distinct base64 nonces", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
