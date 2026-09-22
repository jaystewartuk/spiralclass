"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PostHogReactProvider } from "posthog-js/react";
import * as Sentry from "@sentry/nextjs";
import { initBrowserAnalytics } from "@/lib/analytics/posthog-browser";
import { posthogRegionHosts } from "@/lib/analytics/posthog-region";

type SentryIntegrationArg = Parameters<typeof Sentry.addIntegration>[0];

// Mounted once in the root layout so posthog-js (autocapture, session
// replay, feature flags, surveys, web vitals) is available across the
// whole app, and the React feature-flag hooks have a client to read.
//
// No-op when NEXT_PUBLIC_POSTHOG_KEY is absent (local dev without creds,
// or preview deploys not yet wired up): init is skipped and the provider
// just renders children, so hooks fall back to their defaults and the
// app still loads. SSR-safe — init is client-guarded (typeof window).
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  // Initialize during render — NOT in an effect — so posthog is ready before
  // any descendant's effect runs. React fires child effects before parent
  // effects, so a <PostHogIdentify> mounted in the same commit (e.g. a hard
  // load straight into /dashboard after the magic-link redirect) would call
  // identify() before this provider's effect ran init(); posthog-js silently
  // drops pre-init identify calls, leaving the user split across an anonymous
  // Person. A useState initializer runs exactly once, during the first
  // (client) render, before children render or mount their effects.
  useState(() => {
    if (typeof window === "undefined") return null;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return null;
    // Default to the same-origin reverse proxy (next.config.ts rewrites
    // /ingest → the regional cloud). NEXT_PUBLIC_POSTHOG_HOST is an optional
    // escape hatch to point the client straight at PostHog (e.g. debugging the
    // proxy). ui_host is the regional PostHog app host for outbound links —
    // region is NEXT_PUBLIC_POSTHOG_REGION (default US); see D-48.
    const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || "/ingest";
    initBrowserAnalytics({ key, apiHost, uiHost: posthogRegionHosts().ui });
    return null;
  });

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    // Superpower: stamp every Sentry event with the PostHog "Recording
    // URL" + "Person URL" tags. Because the "Report a problem" dialog
    // posts through the same Sentry pipeline, each report arrives
    // with a one-click link to the session replay of exactly what the
    // person was doing — so we stop relying on users to write good repro
    // steps and just watch it. The same tags land on ordinary client
    // errors, turning any Sentry issue into a jump-to-replay too.
    //
    //   • severityAllowList "*"  — the default is error-only, which would
    //     skip feedback events (they aren't level "error"); "*" lets the
    //     tags ride along on feedback and warnings as well.
    //   • sendExceptionsToPostHog false — PostHog already has its own
    //     capture + replay; we only want the forward Sentry→PostHog link,
    //     not to mirror Sentry exceptions back as PostHog events.
    //
    // Wrapped so a telemetry-wiring hiccup can never block app load, and a
    // no-op when the Sentry client isn't initialised (missing DSN →
    // addIntegration has no client to attach to).
    try {
      Sentry.addIntegration(
        posthog.sentryIntegration({
          severityAllowList: "*",
          sendExceptionsToPostHog: false,
        }) as unknown as SentryIntegrationArg,
      );
    } catch {
      // ignore — analytics must never break the page
    }
  }, []);

  return <PostHogReactProvider client={posthog}>{children}</PostHogReactProvider>;
}
