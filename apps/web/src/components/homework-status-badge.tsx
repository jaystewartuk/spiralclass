import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { HomeworkSubmissionStatus } from "@spiralclass/shared";
import type { TFunction } from "@/lib/i18n-translate";

// Web mirror of the mobile HomeworkStatusBadge — same tone mapping, so the
// two never drift on what each status means. Takes `t` as a prop (rather than
// calling useT() itself) so it stays a plain Server Component, like
// booking-status-badge.tsx — the class-detail page already has `t` from its
// own top-level `await getT()`.
const TONE: Record<HomeworkSubmissionStatus, NonNullable<BadgeProps["variant"]>> = {
  not_submitted: "outline",
  draft: "info",
  submitted: "success",
  late: "warning",
  returned: "warning",
  graded: "success",
};

export function HomeworkStatusBadge({
  status,
  t,
}: {
  status: HomeworkSubmissionStatus;
  t: TFunction;
}) {
  return <Badge variant={TONE[status]}>{t(`homework.status.${status}`)}</Badge>;
}
