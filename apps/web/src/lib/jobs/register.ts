import type { PgBoss } from "pg-boss";
import type { QueueOptions, ScheduleOptions, WorkHandler } from "pg-boss";

// Phase 0 scaffold (docs/architecture/overview.md). Mirrors
// the shape of lib/inngest/functions/index.ts's `functions` array: one entry
// per job, registered here rather than scattered across boot code. Empty
// until Phase 1 ports the first cron, and Phase 2 the first event handler —
// adding one is then a single push onto `jobDefinitions`, same as adding to
// that array.
export interface JobDefinition<ReqData = unknown, ResData = unknown> {
  // Queue name — for a ported Inngest function, reuse its event name
  // (event-driven jobs) or its `id` (crons), so the queue table reads like
  // the inventory in the audit.
  queue: string;
  queueOptions?: QueueOptions;
  handler: WorkHandler<ReqData, ResData>;
  // Present only for cron jobs (mirrors the inventory's the teacher profile "Schedule"
  // column). `pg-boss`'s own distributed-singleton locking is what lets both
  // Fly machines run the same schedule() call without double-firing.
  cron?: {
    pattern: string;
    data?: object;
    options?: ScheduleOptions;
  };
}

// The default registry. Deliberately empty: the actual Phase 1 definitions
// (the 15 crons in ./crons) are composed and passed explicitly at the
// flag-gated worker-boot site (startJobsWorker in ./boss), via a dynamic
// import — that keeps this mechanism module, and every module that merely
// imports it, free of the crons' transitive dependency on the Inngest client
// (which validates the server env at load). Event-handler jobs join the
// same boot composition in Phase 2.
export const jobDefinitions: JobDefinition[] = [];

// Creates each definition's queue and attaches its worker (and cron
// schedule, if any). Called once from lib/jobs/boss.ts's startJobsWorker()
// after `boss.start()`. Takes an explicit `definitions` param (defaulting to
// the module-level registry) so tests can register a throwaway definition
// against a real pg-boss instance without touching the app-wide list.
export async function registerJobs(
  boss: PgBoss,
  definitions: JobDefinition[] = jobDefinitions,
): Promise<void> {
  for (const def of definitions) {
    await boss.createQueue(def.queue, def.queueOptions);
    await boss.work(def.queue, def.handler);
    if (def.cron) {
      await boss.schedule(def.queue, def.cron.pattern, def.cron.data, def.cron.options);
    }
  }
}
