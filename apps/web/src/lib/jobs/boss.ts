import type { PgBoss } from "pg-boss";
import { isPreviewDeployment, jobsBackend, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { registerJobs } from "./register";

// Phase 0 scaffold (docs/architecture/overview.md).
//
// Connects on Neon's DIRECT/session endpoint, never the pooled
// (PgBouncer transaction-mode) DATABASE_URL — advisory locks and
// LISTEN/NOTIFY both require a session-pinned connection, which the
// transaction pooler cannot provide (see the audit's infrastructure table).
// A small dedicated pool keeps this separate from the request-path pool.
//
// `PgBoss` itself is imported as a type only — the real class is loaded via
// dynamic import() below, so its runtime (and the `pg` client it drags in)
// never lands in a route's bundle unless JOBS_BACKEND=pgboss actually calls
// getBoss()/createBoss(). Every producer's best-effort `enqueue()` seam
// (lib/jobs/enqueue.ts) reaches this module on its default "inngest"
// codepath purely to read `getBoss` off the module — a static top-level
// `import { PgBoss } from "pg-boss"` here would pull the whole package into
// every one of those bundles (notably /api/inngest, which the whole cron fleet
// hits hourly) for a class that's never instantiated.

const log = logger({ surface: "jobs" });

export async function createBoss(connectionString: string): Promise<PgBoss> {
  const { PgBoss } = await import("pg-boss");
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    max: 4,
    useListenNotify: true,
  });
  boss.on("error", (err) => log.error("pg-boss error", err));
  return boss;
}

let singleton: PgBoss | null = null;
let singletonPromise: Promise<PgBoss> | null = null;

// The app-wide pg-boss instance, built lazily on first access. Does NOT
// start it — call startJobsWorker() (from instrumentation.ts) for that.
export async function getBoss(): Promise<PgBoss> {
  if (singleton) return singleton;
  if (!singletonPromise) {
    singletonPromise = createBoss(serverEnv().DIRECT_URL).then((boss) => {
      singleton = boss;
      return boss;
    });
  }
  return singletonPromise;
}

let started = false;

// Boots the in-process worker: connects, applies pg-boss's own schema
// migrations, and attaches every registered queue/cron. A no-op whenever
// JOBS_BACKEND isn't "pgboss" (the default), so today this changes nothing —
// it only does work once a Phase deliberately flips the flag. Failures are
// logged, not thrown: this is new, optional infrastructure and must never be
// able to take down app boot for a flag most deployments haven't set yet.
export async function startJobsWorker(): Promise<void> {
  if (jobsBackend() !== "pgboss") return;
  if (started) return;
  started = true;
  try {
    const boss = await getBoss();
    await boss.start();
    // Compose the definition list here, via dynamic imports, so the jobs'
    // transitive dependency on the Inngest client (dual-run emits) is only
    // pulled in when the worker actually boots — not whenever something imports
    // this module or ./register. Crons (Phase 1) + event handlers (Phase 2a).
    const { cronJobs } = await import("./crons");
    const { eventJobs } = await import("./events");
    // Crons are skipped on the preview deploy, mirroring the Inngest side
    // (lib/inngest/functions/index.ts) so the two backends stay identical
    // under the dual-run. Preview has no real users for these to serve, and
    // every tick is a DB touch that buys 5 minutes of billed Neon compute —
    // see isPreviewDeployment in lib/env for the full cost note.
    const definitions = isPreviewDeployment() ? eventJobs : [...cronJobs, ...eventJobs];
    await registerJobs(boss, definitions);
    log.info("pg-boss worker started", { jobs: definitions.length });
  } catch (err) {
    started = false;
    log.error("pg-boss worker failed to start", err);
  }
}

// Graceful shutdown — used by tests and available for a future process
// SIGTERM hook. No-ops if the worker was never started.
export async function stopJobsWorker(): Promise<void> {
  if (!singleton || !started) return;
  await singleton.stop();
  started = false;
}
