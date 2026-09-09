import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { sendWeeklyPlanNudges } from "@/lib/notifications/weekly-plan-nudge";

// Weekly cron, Mondays at 16:00 UTC (~10:00 Mexico City) — a calm weekday
// morning to start the week. Builds each teacher's student-acquisition plan and
// tells her what the first prepared action is. Replaces the fortnightly
// Facebook-groups nudge (D-125), which said only that she should post. Pure
// handler in src/lib/notifications/weekly-plan-nudge.ts.
export const weeklyPlanNudgeCronFn = inngest.createFunction(
  {
    id: "weekly-plan-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 16 * * 1" }],
  },
  async ({ step }) => step.run("send-weekly-plan-nudges", () => sendWeeklyPlanNudges({ prisma })),
);
