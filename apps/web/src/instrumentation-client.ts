// Next.js client-side Sentry init (Slice 7a). Loaded automatically by the
// Next runtime when present; NEXT_PUBLIC_SENTRY_DSN missing → no-op.

import * as Sentry from "@sentry/nextjs";
import { sentryEnvironment } from "@/lib/sentry-environment";
import { SENTRY_DENY_URLS, SENTRY_IGNORE_ERRORS } from "@/lib/sentry-noise-filters";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Session Replay — ERROR-TRIGGERED ONLY. The SDK records sessions by
    // default, which quietly consumed ~82% of the 50/mo free-tier replay quota.
    // We don't need all-session replay here: PostHog already records product
    // flows (booking/checkout) for UX analysis. Sentry replay earns its keep
    // only when it's bolted onto an actual error — so record 0% of ordinary
    // sessions and 100% of sessions that hit an error. Consumption drops to
    // roughly "error sessions", well under the free cap, keeping the replays
    // that actually help debugging.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    environment: sentryEnvironment(),
    // Injected-code noise that isn't ours to fix (SPIRALCLASS-2T) — see
    // sentry-noise-filters.ts for what these match and why.
    ignoreErrors: SENTRY_IGNORE_ERRORS,
    denyUrls: SENTRY_DENY_URLS,
    beforeSend(event) {
      // Drop the transient LiveKit connection-drop noise from the in-call
      // screen. On mobile the websocket/peerconnection can fail (close 1006,
      // "peerconnection failed") and LiveKit auto-reconnects; the failure
      // surfaces as an UNHANDLED REJECTION whose reason is a DOM error Event
      // (Sentry renders it "… (type=error) captured as promise rejection").
      // It's not an actionable app fault — a final, unrecoverable disconnect
      // shows the in-call error UI (ClassCall handles RoomEvent.Disconnected)
      // instead. Scoped tightly (unhandled rejection + that exact shape + the
      // /call route) so real errors still report.
      const ex = event.exception?.values?.[0];
      const isUnhandledRejection = ex?.mechanism?.type === "onunhandledrejection";
      const isErrorEventRejection = /captured as promise rejection/.test(ex?.value ?? "");
      const onCallScreen =
        (event.transaction ?? "").endsWith("/call") || (event.request?.url ?? "").includes("/call");
      if (isUnhandledRejection && isErrorEventRejection && onCallScreen) return null;

      // Drop browser-injected `window.__firefox__` noise. Several iOS
      // browsers (Brave, Firefox Focus, and others) are built on forks of
      // Mozilla's iOS content-blocker/reader-mode bridge and inject a
      // `window.__firefox__` script into every page for their reader-view /
      // video-quality features. When that injected script races the page
      // load, it throws before any of our own code runs — not tied to any
      // specific route, since it's not our code. Not scoped by route or
      // mechanism (unlike the LiveKit filter above) because this is pure
      // third-party noise, never something our app references.
      const isFirefoxInjectionNoise = /__firefox__/.test(ex?.value ?? "");
      if (isFirefoxInjectionNoise) return null;

      return event;
    },
    integrations: [
      // Session Replay, configured explicitly (rather than left to the SDK
      // default) so masking is locked down for a payments app: mask every text
      // node + input and block all media, so a replay attached to an error
      // never carries student PII, emails, or payment fields. Sampling is set
      // to error-only above (replaysSessionSampleRate: 0).
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
      // NOTE: there is deliberately NO `feedbackIntegration` here.
      //
      // The SDK's own dialog used to render the "Report a problem" form. It was
      // replaced by a first-party one (components/report-problem-dialog.tsx)
      // built from the app's design system, because three of its properties
      // could not be configured away: its copy was pinned to one language at
      // init time (Spanish, in an app whose default locale is `en` and which
      // also ships French), it stretched to the full viewport height on a phone,
      // and its screenshot button is desktop-only by construction — the SDK's
      // `isScreenshotSupported()` returns false for every phone, which is where
      // the reports come from.
      //
      // Nothing about the transport changed: that dialog calls
      // `Sentry.sendFeedback()`, which needs only an initialised client, so
      // reports still land in this project with the session replay and the last
      // error event attached. Re-adding the integration would ship the widget's
      // bundle again for a dialog nothing opens.
    ],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
