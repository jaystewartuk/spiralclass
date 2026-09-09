import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { sendPackageExpiryNudges } from "@/lib/notifications/package-expiry-nudge";

// Daily cron at 15:00 UTC (~09:00 Mexico City). Emails students whose
// active package expires within 7 days and still has unused classes,
// nudging them to book before the classes lapse — recovering revenue that
// would otherwise be silently forfeited. One nudge per package (dedup in
// the handler). Pure handler in
// src/lib/notifications/package-expiry-nudge.ts.
export const packageExpiryNudgeCronFn = inngest.createFunction(
  {
    id: "package-expiry-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 15 * * *" }],
  },
  async ({ step }) => step.run("send-expiry-nudges", () => sendPackageExpiryNudges({ prisma })),
);
