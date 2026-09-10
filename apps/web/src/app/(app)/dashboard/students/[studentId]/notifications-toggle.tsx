"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import {
  setStudentNotificationsAsTeacherAction,
  type NotificationsToggleFormState,
} from "@/app/actions/notification-prefs";
import { useT } from "@/components/locale-provider";

// One-tap "launch this student" switch for a roster-imported student's
// notifications — see lib/notifications/preferences.ts /
// lib/students/notification-toggle.ts. A CSV import starts every student
// fully silenced; this is how the teacher turns a specific student's
// booking/class alerts on once she's ready, without the student needing to
// sign in first.
export function NotificationsToggle({
  studentId,
  enabled,
}: {
  studentId: string;
  enabled: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<NotificationsToggleFormState, FormData>(
    setStudentNotificationsAsTeacherAction,
    undefined,
  );

  return (
    <form action={formAction} className="mt-4 space-y-2 border-t pt-4">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="enabled" value={(!enabled).toString()} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {t("web.dashboard.students.notifications.label")}:{" "}
            <span className={enabled ? "text-success" : "text-warning"}>
              {enabled
                ? t("web.dashboard.students.notifications.on")
                : t("web.dashboard.students.notifications.offImported")}
            </span>
          </p>
          {!enabled && (
            <p className="text-muted-foreground text-xs">
              {t("web.dashboard.students.notifications.offHint")}
            </p>
          )}
        </div>
        <Button type="submit" variant={enabled ? "outline" : "default"} disabled={pending}>
          {pending
            ? t("web.dashboard.students.package.saving")
            : enabled
              ? t("web.dashboard.students.notifications.disable")
              : t("web.dashboard.students.notifications.enable")}
        </Button>
      </div>
      <FormStatus state={state} />
    </form>
  );
}
