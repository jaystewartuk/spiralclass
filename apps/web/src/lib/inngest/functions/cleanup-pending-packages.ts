import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { cleanupAbandonedPendingPackages } from "@/lib/payments/cleanup-pending";

// Daily cron at 03:00 UTC. Drops Package + Payment rows in 'pending'
// status older than 7 days (closes the abandoned-checkout drift gap).
// Pure handler in `src/lib/payments/cleanup-pending.ts`.

export const cleanupPendingPackagesCronFn = inngest.createFunction(
  {
    id: "cleanup-pending-packages-cron",
    retries: 1,
    triggers: [{ cron: "0 3 * * *" }],
  },
  async ({ step }) =>
    step.run("cleanup-pending", () => cleanupAbandonedPendingPackages({ prisma })),
);
