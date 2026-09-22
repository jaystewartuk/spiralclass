import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage/provider";
import { purgeExpiredMaterials } from "@/lib/storage/materials-purge";

// Class-materials upload daily auto-purge for class materials older than one year. Runs at
// 02:00 UTC. The storage provider deletes the underlying object; the pure
// handler in `src/lib/storage/materials-purge.ts` does the heavy lifting.

export const materialsPurgeCronFn = inngest.createFunction(
  {
    id: "materials-purge-cron",
    retries: 1,
    triggers: [{ cron: "0 2 * * *" }],
  },
  async ({ step }) =>
    step.run("purge-old-materials", () =>
      purgeExpiredMaterials({
        prisma,
        storage: getStorageProvider(),
      }),
    ),
);
