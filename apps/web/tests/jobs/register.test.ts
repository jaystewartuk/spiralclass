import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

import { jobDefinitions, registerJobs, type JobDefinition } from "@/lib/jobs/register";

// register.ts mirrors lib/inngest/functions/index.ts's `functions` array —
// registerJobs() walks each definition and wires it onto a real (or, here,
// fake) PgBoss instance. Fake-boss unit tests mirror the existing Inngest
// handler pattern (a structural `step` fake) so this stays testable without
// a database.

function fakeBoss() {
  return {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => "worker-id"),
    schedule: vi.fn(async () => {}),
  };
}

describe("jobDefinitions", () => {
  it("is empty in Phase 0 — no handler has been ported onto pg-boss yet", () => {
    expect(jobDefinitions).toEqual([]);
  });
});

describe("registerJobs", () => {
  it("creates the queue and attaches the worker for each definition", async () => {
    const boss = fakeBoss();
    const handler = vi.fn();
    const defs: JobDefinition[] = [{ queue: "example.queue", handler }];

    await registerJobs(boss as unknown as PgBoss, defs);

    expect(boss.createQueue).toHaveBeenCalledWith("example.queue", undefined);
    expect(boss.work).toHaveBeenCalledWith("example.queue", handler);
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("schedules a cron when the definition has one", async () => {
    const boss = fakeBoss();
    const handler = vi.fn();
    const defs: JobDefinition[] = [
      {
        queue: "example.cron",
        handler,
        cron: { pattern: "*/15 * * * *", data: { foo: "bar" } },
      },
    ];

    await registerJobs(boss as unknown as PgBoss, defs);

    expect(boss.schedule).toHaveBeenCalledWith(
      "example.cron",
      "*/15 * * * *",
      { foo: "bar" },
      undefined,
    );
  });

  it("registers every definition in order, and no-ops on an empty list", async () => {
    const boss = fakeBoss();

    await registerJobs(boss as unknown as PgBoss, []);
    expect(boss.createQueue).not.toHaveBeenCalled();

    const defs: JobDefinition[] = [
      { queue: "q1", handler: vi.fn() },
      { queue: "q2", handler: vi.fn() },
    ];
    await registerJobs(boss as unknown as PgBoss, defs);
    expect(boss.createQueue).toHaveBeenNthCalledWith(1, "q1", undefined);
    expect(boss.createQueue).toHaveBeenNthCalledWith(2, "q2", undefined);
  });

  it("defaults to the module-level jobDefinitions registry", async () => {
    const boss = fakeBoss();
    await registerJobs(boss as unknown as PgBoss);
    expect(boss.createQueue).not.toHaveBeenCalled();
  });
});
