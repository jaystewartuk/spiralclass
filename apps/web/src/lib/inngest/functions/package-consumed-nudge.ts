import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { sendPackageConsumedNudges } from "@/lib/notifications/package-consumed-nudge";

// Daily cron at 17:00 UTC (~11:00 Mexico City), staggered after the expiry
// nudge. Was 15:30 until D-115: on the hourly wake grid a `:30` cron is the
// only thing awake at that minute, so it bought a whole extra 5-minute Neon
// wake window for one daily email. Kept on its own hour instead, which
// preserves the stagger the send-load spreading wanted for free. Emails students whose package is fully used and who haven't started
// a follow-up purchase — the "buy again" half of the one-off-package revenue
// model — and gives the teacher a repeat-purchase heads-up. One nudge per
// package (dedup in the handler). Pure handler in
// src/lib/notifications/package-consumed-nudge.ts.
export const packageConsumedNudgeCronFn = inngest.createFunction(
  {
    id: "package-consumed-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 17 * * *" }],
  },
  async ({ step }) => step.run("send-consumed-nudges", () => sendPackageConsumedNudges({ prisma })),
);
