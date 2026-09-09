import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { getEmailClient } from "@/lib/email";
import {
  dispatchNotification,
  getDefaultDispatcherWebPushClient,
  sendChatEmailFallbackIfUnread,
  type DispatcherDeps,
} from "@/lib/notifications/dispatcher";
import { serverEnv } from "@/lib/env";
import { getStorageProvider } from "@/lib/storage/provider";

// Triggered by producers that write `status='queued'` rows. Retries up to
// 3 times on thrown errors (transient network / 5xx / 429). Non-retryable
// failures are marked inside the dispatcher via `markFailed`.
//
// tenant isolation: runs with service-role DB access. The dispatcher itself filters
// every query by teacher_id — the event payload merely carries the id so
// we don't need to re-derive it.

// Grace window between a chat push and its email fallback. If the recipient
// opens the thread within it, no email is sent — email is only for a message
// they never saw. Short enough to be a useful catch-up, long enough that an
// active reader never gets an email for something they're looking at.
const CHAT_EMAIL_FALLBACK_GRACE = "3m";

// Exported so the pg-boss event definition (lib/jobs/events.ts) builds the
// exact same dispatcher deps (Phase 2a, docs/architecture/overview.md).
export function makeDeps(): DispatcherDeps {
  return {
    prisma,
    // Null when VAPID isn't configured — the push channel is then unavailable
    // and the cascade falls through to email.
    webPush: getDefaultDispatcherWebPushClient(),
    email: getEmailClient(),
    appUrl: serverEnv().APP_URL,
    storage: getStorageProvider(),
    sessionSecret: serverEnv().SESSION_SECRET,
  };
}

export const dispatchNotificationFn = inngest.createFunction(
  {
    id: "dispatch-notification",
    retries: 3,
    triggers: [{ event: "notification.queued" }],
  },
  async ({ event, step }) => {
    const { notificationId } = event.data as { notificationId: string };
    const outcome = await step.run("send", async () => {
      return dispatchNotification(notificationId, makeDeps());
    });

    // Chat push→email cascade: the dispatcher pushed a chat message and
    // deliberately skipped email (recipient has the app). Wait out the grace
    // window, then email only if they still haven't opened the thread.
    if (
      outcome.code === "sent" &&
      outcome.channel === "push" &&
      (outcome.templateName === "chat_message" || outcome.templateName === "chat_message_teacher")
    ) {
      await step.sleep("chat-email-grace", CHAT_EMAIL_FALLBACK_GRACE);
      await step.run("chat-email-fallback", async () => {
        return sendChatEmailFallbackIfUnread(notificationId, makeDeps());
      });
    }

    return outcome;
  },
);
