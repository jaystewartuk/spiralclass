import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage/provider";
import { purgeExpiredMaterials } from "@/lib/storage/materials-purge";
import { purgeExpiredGenerationBodies } from "@/lib/materials/generations";

// Class-materials upload daily auto-purge for class materials older than one year. Runs at
// 02:00 UTC. The storage provider deletes the underlying object; the pure
// handler in `src/lib/storage/materials-purge.ts` does the heavy lifting.
//
// The same tick clears the text of AI materials generations past their
// 30-day retention (D-202) — a second step rather than a second cron, because
// every distinct cron minute is its own database wake (functions/index.ts).

export const materialsPurgeCronFn = inngest.createFunction(
  {
    id: "materials-purge-cron",
    retries: 1,
    triggers: [{ cron: "0 2 * * *" }],
  },
  async ({ step }) => {
    const materials = await step.run("purge-old-materials", () =>
      purgeExpiredMaterials({
        prisma,
        storage: getStorageProvider(),
      }),
    );
    const generationBodies = await step.run("purge-generation-bodies", () =>
      purgeExpiredGenerationBodies(prisma),
    );
    return { materials, generationBodies };
  },
);
