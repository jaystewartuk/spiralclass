import { toBarSeries, type ChartDatum } from "@spiralclass/shared";
import type { NotificationStatus } from "@prisma/client";

// Shared status→label/color mapping for the admin "notifications by status"
// bar chart (teacher + student detail pages), so both read the same way.
export const NOTIFICATION_STATUSES: NotificationStatus[] = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "suppressed",
];

const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  suppressed: "Suppressed",
};

const NOTIFICATION_STATUS_COLORS: Record<NotificationStatus, string> = {
  queued: "hsl(var(--warning))",
  sending: "hsl(var(--muted-foreground))",
  sent: "hsl(var(--info))",
  delivered: "hsl(var(--success))",
  failed: "hsl(var(--destructive))",
  suppressed: "hsl(var(--muted-foreground))",
};

export function notificationStatusChartData(
  counts: Partial<Record<NotificationStatus, number>>,
): ChartDatum[] {
  return toBarSeries(
    counts,
    NOTIFICATION_STATUSES,
    NOTIFICATION_STATUS_LABELS,
    NOTIFICATION_STATUS_COLORS,
  );
}
