import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { sendTransferConfirmReminders } from "@/lib/payments/transfer-confirm-reminder";

// Every 6 hours. Emails the teacher about Wise payments a student marked sent
// ≥ 24h ago that are still unconfirmed — recovering money that sits
// unactivated when the teacher forgets to confirm receipt. One reminder per
// payment (dedup in the handler). Pure handler in
// src/lib/payments/transfer-confirm-reminder.ts.
export const wiseConfirmReminderCronFn = inngest.createFunction(
  {
    id: "wise-confirm-reminder-cron",
    retries: 1,
    triggers: [{ cron: "0 */6 * * *" }],
  },
  async ({ step }) =>
    step.run("send-wise-confirm-reminders", () => sendTransferConfirmReminders({ prisma })),
);
