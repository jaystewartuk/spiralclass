import { afterAll, beforeAll, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";

import { createBoss } from "@/lib/jobs/boss";
import { describeIntegration, hasTestDb } from "../_setup/test-db";

// Phase 0 (docs/architecture/overview.md): "Add integration
// tests that drive a real job end-to-end against the local Postgres." This
// exercises the actual pg-boss library — schema bootstrap, queue creation,
// send, and worker delivery — against docker-compose.test.yml's Postgres,
// independent of the (still-empty) app job registry.

const QUEUE = "jobs-phase0-scaffold-smoke-test";

describeIntegration("pg-boss scaffold (Phase 0)", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    if (!hasTestDb()) return;
    boss = await createBoss(process.env.TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue(QUEUE);
  });

  afterAll(async () => {
    if (!boss) return;
    await boss.deleteQueue(QUEUE).catch(() => {});
    await boss.stop({ graceful: false });
  });

  it("delivers a sent job to its worker end-to-end via a real Postgres queue", async () => {
    const received: unknown[] = [];
    let resolveProcessed: () => void;
    const processed = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });

    await boss.work<{ greeting: string }>(QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      received.push(job.data);
      resolveProcessed();
    });

    const jobId = await boss.send(QUEUE, { greeting: "hola" });
    expect(jobId).toBeTruthy();

    await Promise.race([
      processed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("job was not processed in time")), 10_000),
      ),
    ]);

    expect(received).toEqual([{ greeting: "hola" }]);
  }, 15_000);
});
