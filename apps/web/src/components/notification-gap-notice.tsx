import Link from "next/link";
import { BellOff } from "lucide-react";
import type { NotificationCategory } from "@spiralclass/shared";
import { studentDetailHref } from "@/app/(app)/dashboard/students/[studentId]/student-detail-nav";
import { CATEGORY_LABEL_KEYS } from "@/lib/notifications/category-labels";
import { isNotificationsFullyDisabled } from "@/lib/notifications/preferences";
import { studentNotificationGap } from "@/lib/notifications/student-gap";
import type { TFunction } from "@/lib/i18n-translate";

/**
 * Teacher-only notice that a student will not be TOLD about what the teacher
 * is sending or assigning (D-204). Renders nothing when she will.
 *
 * The dispatcher silences a category before any channel is tried, so a
 * material or homework item reached the student's portal while the teacher's
 * screen gave no hint that no push or email followed. This says so, where the
 * teacher is looking, and links to the one switch that changes it for an
 * imported (paused) student. It never touches the student's own opt-outs.
 */
export function NotificationGapNotice({
  studentId,
  studentName,
  prefs,
  category,
  t,
}: {
  studentId: string;
  studentName: string;
  prefs: Partial<Record<string, unknown>> | null | undefined;
  category: NotificationCategory;
  t: TFunction;
}) {
  const gap = studentNotificationGap(prefs, category);
  if (gap === "ok") return null;

  const message =
    gap === "paused"
      ? t("web.notificationGap.paused", { name: studentName })
      : t("web.notificationGap.categoryOff", {
          name: studentName,
          category: t(CATEGORY_LABEL_KEYS[category]).toLowerCase(),
        });

  return (
    <div
      role="note"
      data-notification-gap={gap}
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm"
    >
      <BellOff className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        {message}
        {gap === "paused" && (
          <>
            {" "}
            <Link
              href={studentDetailHref(studentId, "settings")}
              className="font-medium underline underline-offset-4"
            >
              {t("web.notificationGap.turnOn")}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The same notice about the student as a whole, for the top of her page (#77).
 *
 * Go live lifts the onboarding hold and nothing else, so a student whose every
 * category is stored off is "live" and still receives no confirmation, reminder
 * or anything else. Go live cannot switch those on for her: the all-off map
 * cannot be told apart from her own opt-out (D-204). This says so on every tab,
 * where the Go live card stood, until someone turns them on. Renders nothing
 * while the hold is on (the Go live card already says nothing is sent) or the
 * pairing is archived (nothing is sent either way).
 */
export function StudentNotificationsOffNotice({
  studentId,
  studentName,
  prefs,
  onHold,
  archived,
  t,
}: {
  studentId: string;
  studentName: string;
  prefs: Partial<Record<string, unknown>> | null | undefined;
  onHold: boolean;
  archived: boolean;
  t: TFunction;
}) {
  if (onHold || archived || !isNotificationsFullyDisabled(prefs)) return null;

  return (
    <div
      role="note"
      data-notification-gap="student_off"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm"
    >
      <BellOff className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        {t("web.notificationGap.studentOff", { name: studentName })}{" "}
        <Link
          href={studentDetailHref(studentId, "settings")}
          className="font-medium underline underline-offset-4"
        >
          {t("web.notificationGap.turnOn")}
        </Link>
      </p>
    </div>
  );
}
