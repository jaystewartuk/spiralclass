import { describe, expect, it, vi } from "vitest";

// This is a registry/wiring test — it inspects each cron's queue name, cron
// pattern, and the registerJobs wiring, and never executes a handler. Stub the
// Inngest client so importing crons.ts (transitively → inngest/client) doesn't
// eagerly validate the server env at module load, matching the pattern the
// other inngest suites use.
vi.mock("@/lib/inngest/client", () => ({
  inngest: { send: vi.fn(), createFunction: () => ({}) },
}));
// The weekly-plan nudge (D-125) reaches lib/marketing/plan, which is
// `server-only`. This suite never runs a handler, so the marker is noise here.
vi.mock("server-only", () => ({}));

import { cronJobs } from "@/lib/jobs/crons";
import { registerJobs, type JobDefinition } from "@/lib/jobs/register";

// Phase 1 (docs/architecture/overview.md): the 15 Inngest
// crons ported to pg-boss definitions.
//
// The schedule table below is the drift guard: it pins every ported cron's
// queue name (= the Inngest function `id`) to its cron pattern (= the Inngest
// `triggers: [{ cron }]`, copied verbatim). If a pattern here ever diverges
// from the Inngest source, the two backends would fire on different schedules
// during the dual-run — this test fails first. When Phase 3 deletes the
// Inngest crons, this table becomes the single source of truth for the
// schedules, so keep it exact.
const EXPECTED_SCHEDULES: Record<string, string> = {
  "poll-wise-statements-cron": "0 * * * *",
  "sync-google-calendars-cron": "0 * * * *",
  "reconcile-paid-payments-cron": "0 * * * *",
  "auto-complete-sweep-cron": "0 * * * *",
  "anomaly-alerts-cron": "0 * * * *",
  "account-deletion-cron": "0 4 * * *",
  "subscription-sweep-cron": "0 14 * * *",
  "cleanup-pending-packages-cron": "0 3 * * *",
  "materials-purge-cron": "0 2 * * *",
  "package-expiry-nudge-cron": "0 15 * * *",
  "package-consumed-nudge-cron": "0 17 * * *",
  "wise-confirm-reminder-cron": "0 */6 * * *",
  // D-125: replaced the fortnightly Facebook-groups nudge on the same slot.
  "weekly-plan-nudge-cron": "0 16 * * 1",
  "invitations-pending-nudge-cron": "0 15 * * *",
  "redispatch-queued-cron": "0 * * * *",
  "reminder-scan-cron": "0 * * * *",
};

// Every minute-of-hour a cron in the fleet fires on. Neon's scale-to-zero timer
// is fixed at 5 minutes on the Free plan, so a DB touch buys 5 minutes of billed
// compute and ticks sharing a minute share one wake window — the monthly spend
// is set by how many DISTINCT minutes the fleet uses, not by how many jobs run.
//
// The grid is minute :00 and nothing else (D-115): one window an hour, ~2.8
// active h/day, ~22 of the 100 free CU-hours/project/month. It was
// :00/:15/:30/:45 until then, which measured ~11 active h/day (~89 CU-hours) on
// production against ~0.7 min of real work per tick — the rest was pure idle
// timer. Any other minute, including a daily `30 16 * * *`, silently opens a
// second window. The escape hatch for a job that genuinely needs sub-hourly
// precision is a delayed event armed at the exact due moment, the way
// reminder-scan's wake chain serves the 15m leg — NOT a tighter grid, which
// charges every job for one job's precision. See lib/env.ts's
// isPreviewDeployment and lib/notifications/reminder-scan.ts.
const WAKE_GRID = [0];

function firingMinutes(pattern: string): number[] {
  const minuteField = pattern.split(" ")[0];
  if (minuteField.startsWith("*/")) {
    const step = Number(minuteField.slice(2));
    return Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);
  }
  return minuteField.split(",").map(Number);
}

describe("jobs/crons — Phase 1 cron registry", () => {
  it("ports exactly the 16 Inngest crons, each with a cron schedule", () => {
    expect(cronJobs).toHaveLength(16);
    for (const def of cronJobs) {
      expect(def.cron, `${def.queue} must be a cron job`).toBeDefined();
      expect(typeof def.handler).toBe("function");
    }
  });

  it("uses unique queue names (no two crons collide on the pg-boss job table)", () => {
    const names = cronJobs.map((d) => d.queue);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins every cron pattern to its Inngest original (drift guard)", () => {
    const actual = Object.fromEntries(cronJobs.map((d) => [d.queue, d.cron?.pattern]));
    expect(actual).toEqual(EXPECTED_SCHEDULES);
  });

  it("keeps every cron on the hourly :00 wake grid (Neon compute-budget guard)", () => {
    const offGrid = cronJobs
      .map((d) => ({
        queue: d.queue,
        stray: firingMinutes(d.cron!.pattern).filter((m) => !WAKE_GRID.includes(m)),
      }))
      .filter((x) => x.stray.length > 0);

    expect(
      offGrid,
      `these crons fire on a minute other than :00, each opening an extra ` +
        `5-minute Neon wake window: ${JSON.stringify(offGrid)}`,
    ).toEqual([]);
  });

  it("registerJobs creates a queue, attaches a worker, and schedules each cron", async () => {
    const boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue("worker-id"),
      schedule: vi.fn().mockResolvedValue(undefined),
    };

    // Two representative defs (one polling, one daily) exercise the wiring
    // without booting a real pg-boss.
    const sample: JobDefinition[] = cronJobs.filter((d) =>
      ["poll-wise-statements-cron", "subscription-sweep-cron"].includes(d.queue),
    );
    expect(sample).toHaveLength(2);

    await registerJobs(boss as never, sample);

    for (const def of sample) {
      expect(boss.createQueue).toHaveBeenCalledWith(def.queue, undefined);
      expect(boss.work).toHaveBeenCalledWith(def.queue, def.handler);
      expect(boss.schedule).toHaveBeenCalledWith(
        def.queue,
        def.cron!.pattern,
        undefined,
        undefined,
      );
    }
  });
});
