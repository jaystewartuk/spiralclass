import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import {
  sendHomeworkDueSoonNudges,
  sendHomeworkOverdueNudges,
} from "@/lib/notifications/homework-reminder-nudge";

// Daily crons (docs/features/homework.md) — offset from the
// package-expiry-nudge cron (15:00 UTC) to spread the daily notification
// sweep load. The overdue leg was 16:30 until D-115; the stagger now runs in
// whole hours because a `:30` cron is alone on the hourly wake grid and buys a
// whole extra 5-minute Neon wake window for one daily email. Pure handlers in
// src/lib/notifications/homework-reminder-nudge.ts.
export const homeworkDueSoonNudgeCronFn = inngest.createFunction(
  {
    id: "homework-due-soon-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 16 * * *" }],
  },
  async ({ step }) => step.run("send-due-soon-nudges", () => sendHomeworkDueSoonNudges({ prisma })),
);

export const homeworkOverdueNudgeCronFn = inngest.createFunction(
  {
    id: "homework-overdue-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 18 * * *" }],
  },
  async ({ step }) => step.run("send-overdue-nudges", () => sendHomeworkOverdueNudges({ prisma })),
);
