"use client";

import { useActionState } from "react";
import { createTeacherBooking, type TeacherBookingState } from "@/app/actions/teacher-booking";
import { ConfirmSlotButton } from "@/components/confirm-slot-button";
import { useT } from "@/components/locale-provider";
import { teacherBookingErrorKey } from "@/lib/booking/teacher-booking-errors";

// Teacher self-serve booking slot (item 10). Mirrors the student
// SlotSubmitButton: tapping a time opens a confirmation dialog restating the
// full date/time before committing, so an accidental tap never books a class.
//
// The failure MESSAGE is resolved here rather than sent from the action. The
// action used to return an already-worded string chosen by an `en ? … : …`
// ternary, which made English the answer for every locale that is not
// Spanish — so a French teacher read a Spanish error. It returns a code now,
// and the code becomes a sentence in the reader's own language on this side.
export function TeacherSlotButton({
  packageId,
  startUtc,
  label,
  secondaryLabel,
  ariaLabel,
  summary,
  subtitle,
}: {
  packageId: string;
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
  const [state, formAction, pending] = useActionState<TeacherBookingState, FormData>(
    createTeacherBooking,
    undefined,
  );

  return (
    <ConfirmSlotButton
      formAction={formAction}
      hiddenInputs={{ packageId, startUtc }}
      pending={pending}
      error={state?.error ? t(teacherBookingErrorKey(state.error)) : undefined}
      timeLabel={label}
      secondaryLabel={secondaryLabel}
      triggerAriaLabel={ariaLabel}
      title={t("teacherBook.confirmAsk.title")}
      summary={summary}
      subtitle={subtitle}
      confirmLabel={t("teacherBook.confirmAsk.cta")}
      pendingLabel={t("teacherBook.booking")}
      cancelLabel={t("common.cancel")}
    />
  );
}
