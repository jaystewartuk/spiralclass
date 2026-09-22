import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";
import { sentryEnvironment } from "@/lib/sentry-environment";

// Sentry server-runtime init (Slice 7a part 1). Loaded by
// instrumentation.ts via dynamic import — that pattern is what the
// @sentry/nextjs SDK expects so its build-time webpack plugin can
// detect and wire the init module. SENTRY_DSN missing → no-op so dev
// + tests stay clean.

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: sentryEnvironment(),
    beforeSend: scrubSentryEvent,
  });
}
