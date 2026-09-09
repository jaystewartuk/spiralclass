import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";
import { sentryEnvironment } from "@/lib/sentry-environment";

// Sentry edge-runtime init (Slice 7a part 1). Mirrors the server config;
// loaded by instrumentation.ts via dynamic import on edge functions.

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: sentryEnvironment(),
    beforeSend: scrubSentryEvent,
  });
}
