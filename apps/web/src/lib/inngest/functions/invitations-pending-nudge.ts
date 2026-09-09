import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { sendPendingInviteNudges } from "@/lib/invitations/nudge";

// Daily cron, 15:00 UTC (~09:00 Mexico City) — reminds teachers about students
// who haven't accepted their invitation yet (D-83). Pure handler in
// src/lib/invitations/nudge.ts; each invitation nudges at most once (dedup on
// reminderSentAt).
export const invitationsPendingNudgeCronFn = inngest.createFunction(
  {
    id: "invitations-pending-nudge-cron",
    retries: 1,
    triggers: [{ cron: "0 15 * * *" }],
  },
  async ({ step }) =>
    step.run("send-pending-invite-nudges", () => sendPendingInviteNudges({ prisma })),
);
