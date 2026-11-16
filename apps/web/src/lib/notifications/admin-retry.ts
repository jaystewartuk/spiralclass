import type { NotificationStatus } from "@prisma/client";
import { INVITATION_NOTIFICATION_TEMPLATE } from "@/lib/invitations/constants";

// Templates whose rows record a send made OUTSIDE the dispatcher, so the
// dispatcher cannot replay them. An invitation (issue #85) is sent
// directly, regardless of preferences; the dispatcher has no template by that
// name, would apply the preference gates the invite skips on purpose, and
// cannot rebuild the accept link because only the token's hash is stored. A
// bounced invitation is fixed by the teacher correcting the address.
const NOT_DISPATCHER_REPLAYABLE: ReadonlySet<string> = new Set([INVITATION_NOTIFICATION_TEMPLATE]);

export function isDispatcherReplayable(templateName: string): boolean {
  return !NOT_DISPATCHER_REPLAYABLE.has(templateName);
}

// Whether /admin/notifications offers Retry on a row. retryNotificationAction
// refuses the same templates through isDispatcherReplayable, so a crafted
// request cannot re-queue what the button hides.
export function canAdminRetryNotification(row: {
  status: NotificationStatus;
  templateName: string;
}): boolean {
  return (
    (row.status === "failed" || row.status === "queued") && isDispatcherReplayable(row.templateName)
  );
}
