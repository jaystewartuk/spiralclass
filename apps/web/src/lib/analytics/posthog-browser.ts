// Browser-side PostHog bootstrap.
//
// As of 2026-06-03 posthog-js is mounted app-wide (root layout) rather
// than only on the public booking funnel — so autocapture, session
// replay, feature flags, surveys, and client events cover the whole
// product. Server-side capture (`posthog-node`, see ./posthog.ts) stays
// the PRIMARY pipeline for the events that must survive ad-blockers
// (server-side analytics capture); the client SDK layers replay + flags + web vitals on top and
// reaches the same Person via identify (keyed by user id).
//
// Initialized lazily from the client provider so the SDK isn't evaluated
// during SSR. Subsequent imports return the same instance — posthog-js
// keeps its own singleton internally.

import posthog, { type PostHog } from "posthog-js";

import { sentryEnvironment } from "@/lib/sentry-environment";

let initialized = false;

// `defaults` pins behavioral defaults to a dated snapshot so a posthog-js
// upgrade can't silently change capture semantics. Bump deliberately
// after reading the changelog. This snapshot already turns on
// history-change pageviews (correct SPA tracking for the App Router — no
// manual capture needed), pageleave, autocapture, and
// person_profiles: 'identified_only'.
const DEFAULTS_SNAPSHOT = "2026-01-30" as const;

export function initBrowserAnalytics(opts: {
  key: string;
  apiHost: string;
  uiHost: string;
}): PostHog {
  if (!initialized) {
    posthog.init(opts.key, {
      // api_host is our own /ingest reverse proxy (next.config.ts) so
      // ad-blockers don't drop events by hostname. ui_host points links
      // (toolbar, "view in PostHog") at the real app.
      api_host: opts.apiHost,
      ui_host: opts.uiHost,
      defaults: DEFAULTS_SNAPSHOT,
      // Anonymous until identify() — booking-funnel visitors don't get a
      // Person until checkout/login. Keeps event volume + cost down.
      person_profiles: "identified_only",
      // Web vitals (LCP/CLS/INP/FCP) as autocaptured events, plus network
      // timing feeding session replay performance.
      capture_performance: { web_vitals: true, network_timing: true },
      // Surfaces console errors/warnings inside recordings — replays are
      // far more useful for debugging with the console attached.
      enable_recording_console_log: true,
      session_recording: {
        // Mask every form input by default (the app collects name/email/
        // WhatsApp/payment refs). Tag any extra sensitive node with
        // class="ph-no-capture" or data-attr for belt-and-braces.
        maskAllInputs: true,
        // Capture request/response HEADERS for network calls in replay
        // (status, timing, URLs) but NOT bodies — this is a payments app
        // and bodies can carry PII / tokens / Stripe payloads.
        recordHeaders: true,
        recordBody: false,
      },
      // Stamp EVERY event with the deployment environment, using the same
      // resolver Sentry uses so the two agree. Lets preview deploys be filtered
      // out of production insights, split by this property rather than
      // separate keys. NOT NODE_ENV: a
      // Next.js preview build is also NODE_ENV=production, so it would read as
      // "production" and mix in (see sentry-environment.ts).
      //
      // Also stamps `platform: "web"` — a fixed value for every event from
      // this client, regardless of the visitor's device. Distinct from the
      // existing per-event `surface` property some ServerEvent variants carry
      // (which client UI triggered a given server-side event) — this is "which
      // app emitted this", always "web" here. Device type (phone vs desktop)
      // is left to
      // PostHog's own autocaptured $device_type — don't conflate the two axes.
      //
      // Done in before_send (not a post-init register) on purpose: init()
      // auto-captures the first $pageview synchronously, BEFORE any post-init
      // register() could apply — that race is why production showed a mix of
      // `environment: production` and unset. before_send runs for every event
      // including that first pageview, so the tag is never missed.
      before_send: (event) => {
        if (!event) return event;
        const properties = { ...event.properties };
        if (!properties.environment) properties.environment = sentryEnvironment();
        if (!properties.platform) properties.platform = "web";
        event.properties = properties;
        return event;
      },
      // Surveys are enabled by default (disable_surveys defaults to
      // false); popover surveys created + targeted in the PostHog
      // dashboard render automatically. No custom UI needed here.
      loaded: (ph) => {
        if (process.env.NODE_ENV !== "production") ph.debug(false);
      },
    });
    initialized = true;
  }
  return posthog;
}

// Convenience accessor for client components that need the current
// session id (e.g. to forward into a server action). Returns null when
// posthog-js wasn't initialized (missing key, ad-blocker, SSR).
export function currentSessionId(): string | null {
  try {
    if (typeof window === "undefined") return null;
    if (!initialized) return null;
    return posthog.get_session_id() ?? null;
  } catch {
    return null;
  }
}

// Returns the PostHog session replay URL for the current session, or null
// when replay isn't running / posthog-js isn't initialized. Used to embed
// the replay link in the WhatsApp support pre-fill so the developer can
// immediately watch what the user was doing when they asked for help.
export function getSessionReplayUrl(): string | null {
  try {
    if (typeof window === "undefined") return null;
    if (!initialized) return null;
    return posthog.get_session_replay_url?.() || null;
  } catch {
    return null;
  }
}

// Bundles the two pieces of context needed to pre-fill a WhatsApp support
// message: who the user is and a link to watch their session.
export function getSupportContext(): {
  distinctId: string | null;
  replayUrl: string | null;
} {
  try {
    if (typeof window === "undefined" || !initialized) {
      return { distinctId: null, replayUrl: null };
    }
    return {
      distinctId: posthog.get_distinct_id?.() ?? null,
      replayUrl: posthog.get_session_replay_url?.() || null,
    };
  } catch {
    return { distinctId: null, replayUrl: null };
  }
}
