"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cancelBookingAsStudent, type CancelState } from "@/app/actions/cancel-booking";
import { useT } from "@/components/locale-provider";
import { HelpTip } from "@/components/help-tip";

// Two-step student cancel: trigger button → confirmation dialog with penalty
// warning → confirm. The server re-classifies on submit (server-authoritative), so the
// preview text is informational only. When the class can still be
// rescheduled, the dialog leads with "reschedule instead" so the student
// keeps the class (and the teacher keeps the revenue) rather than losing it.

export function StudentCancelForm({
  bookingId,
  rulePreview,
  rescheduleEligible,
  rescheduleHref,
}: {
  bookingId: string;
  rulePreview: string;
  rescheduleEligible: boolean;
  rescheduleHref: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<CancelState, FormData>(
    cancelBookingAsStudent,
    undefined,
  );

  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline">
          {t("web.myClasses.cancel.trigger")}
        </Button>
      }
      title={t("web.myClasses.cancel.confirmTitle")}
      footer={(close) => (
        <div className="flex w-full flex-col gap-2">
          {state?.error && (
            <p role="alert" className="text-destructive text-sm">
              {state.error}
            </p>
          )}
          {state?.ok && (
            <p role="status" className="text-success text-sm">
              {state.ok}
            </p>
          )}
          {rescheduleEligible && (
            <Button asChild className="w-full" disabled={pending}>
              <Link href={rescheduleHref}>{t("web.myClasses.cancel.rescheduleInstead")}</Link>
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              form="cancel-booking-form"
              variant={rescheduleEligible ? "outline" : "destructive"}
              disabled={pending}
            >
              {pending ? t("web.myClasses.cancel.canceling") : t("web.myClasses.cancel.yesCancel")}
            </Button>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      )}
    >
      <form id="cancel-booking-form" action={formAction} className="space-y-3">
        <input type="hidden" name="bookingId" value={bookingId} />
        <div className="space-y-1">
          <Label htmlFor="cancel-reason">{t("web.myClasses.cancel.reasonLabel")}</Label>
          <select
            id="cancel-reason"
            name="reason"
            defaultValue=""
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">{t("web.myClasses.cancel.reasonPlaceholder")}</option>
            <option value="schedule_conflict">
              {t("web.myClasses.cancel.reasonScheduleConflict")}
            </option>
            <option value="no_longer_needed">
              {t("web.myClasses.cancel.reasonNoLongerNeeded")}
            </option>
            <option value="other">{t("web.myClasses.cancel.reasonOther")}</option>
          </select>
        </div>
      </form>
      <Alert variant="warning">
        <AlertDescription className="flex items-start gap-1.5">
          <span>{rulePreview}</span>
          <HelpTip
            text={t("web.help.hint.studentBooking.text")}
            label={t("web.help.hint.studentBooking.label")}
            learnMoreHref="/help/student/booking-and-managing-lessons"
            learnMoreLabel={t("web.help.learnMore")}
          />
        </AlertDescription>
      </Alert>
    </ConfirmDialog>
  );
}
