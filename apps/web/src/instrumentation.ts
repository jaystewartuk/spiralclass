// Next.js instrumentation hook (Slice 7a). Server + edge Sentry init.
//
// The dynamic-import pattern is the @sentry/nextjs canonical wiring —
// it lets the SDK's build-time plugin (withSentryConfig in
// next.config.ts) detect the init modules and keep them in the prod
// bundle. SENTRY_DSN missing → no-op (sentry.*.config.ts gates on it).
//
// Lives at src/instrumentation.ts (not the project root) because
// Next.js requires the instrumentation file inside src/ when a src/
// directory exists.

import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    const { assertProductionCredentials } = await import("./lib/env");
    assertProductionCredentials();

    // Background-jobs Phase 0 scaffold (docs/architecture/overview.md).
    // No-ops unless JOBS_BACKEND=pgboss.
    const { startJobsWorker } = await import("./lib/jobs/boss");
    await startJobsWorker();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
