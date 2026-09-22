"use client";

import { useActionState } from "react";
import {
  rescheduleBookingAsTeacher,
  type TeacherRescheduleState,
} from "@/app/actions/teacher-reschedule";
import { ConfirmSlotButton } from "@/components/confirm-slot-button";
import { useT } from "@/components/locale-provider";
import { teacherRescheduleErrorKey } from "@/lib/cancellation/teacher-reschedule-errors";

// One open time on the teacher's "change date and time" picker. Same
// ConfirmSlotButton the student reschedule and the teacher's self-serve
// booking use: tapping a time restates the full date — in both zones, since
// she is routinely moving a class into someone else's clock — before
// anything moves. A misplaced tap here changes a class the student has
// already put in her own calendar.
//
// The failure MESSAGE is worded here, not in the action: the action returns a
// code, and the code becomes a sentence in the reader's own language on this
// side (see lib/cancellation/teacher-reschedule-errors.ts).
export function TeacherRescheduleSlotButton({
  bookingId,
  startUtc,
  label,
  secondaryLabel,
  ariaLabel,
  summary,
  subtitle,
}: {
  bookingId: string;
  startUtc: string;
  label: string;
  /** The student's own clock, when her zone differs from the teacher's. */
  secondaryLabel?: string;
  /** Spelled out by the caller, because it may name both zones. */
  ariaLabel: string;
  summary: string;
  subtitle?: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<TeacherRescheduleState, FormData>(
    rescheduleBookingAsTeacher,
    undefined,
  );

  return (
    <ConfirmSlotButton
      formAction={formAction}
      hiddenInputs={{ bookingId, startUtc }}
      pending={pending}
      error={state?.error ? t(teacherRescheduleErrorKey(state.error)) : undefined}
      timeLabel={label}
      secondaryLabel={secondaryLabel}
      triggerAriaLabel={ariaLabel}
      title={t("teacherReschedule.confirmAsk.title")}
      summary={summary}
      subtitle={subtitle}
      confirmLabel={t("teacherReschedule.confirmAsk.cta")}
      pendingLabel={t("teacherReschedule.pending")}
      cancelLabel={t("common.cancel")}
    />
  );
}
