import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/jobs/enqueue";
import { scanAndScheduleNextWake } from "@/lib/notifications/reminder-scan";

// The reminder wake chain's delivery end (D-115). `reminder-scan-cron` runs
// hourly and arms one delayed `reminder.due` at the exact moment the next
// reminder leg comes due; this handler is what that wake invokes, and it runs
// the SAME scan — firing whatever is now due and arming the next wake in turn.
//
// Why re-scan rather than send the one leg the wake was armed for: the wake
// carries no booking identity on purpose, so there is no stale-timer failure
// mode. A class cancelled or rescheduled in the interim simply isn't due when
// the wake lands, and the re-scan arms the next moment off the live rows. The
// hourly cron is the backstop that restarts the chain if a wake is ever lost.
//
// Registered as an EVENT function, so it exists on preview too — harmless
// there, since preview registers no crons and nothing else produces the event.
export const onReminderDueFn = inngest.createFunction(
  {
    id: "on-reminder-due",
    retries: 1,
    triggers: [{ event: "reminder.due" }],
  },
  async ({ step }) =>
    step.run("scan-due-reminders", () => scanAndScheduleNextWake({ prisma, enqueue })),
);
