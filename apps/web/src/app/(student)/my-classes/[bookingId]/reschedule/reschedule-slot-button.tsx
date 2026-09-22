"use client";

import { useActionState } from "react";
import { rescheduleBooking, type RescheduleState } from "@/app/actions/reschedule-booking";
import { ConfirmSlotButton } from "@/components/confirm-slot-button";
import { useT } from "@/components/locale-provider";

// Reschedule slot: same confirmation dialog as booking (review item 2). An
// accidental tap here would consume the single reschedule the class allows.
export function RescheduleSlotButton({
  bookingId,
  startUtc,
  label,
  summary,
  subtitle,
}: {
  bookingId: string;
  startUtc: string;
  label: string;
  summary: string;
  subtitle?: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<RescheduleState, FormData>(
    rescheduleBooking,
    undefined,
  );

  return (
    <ConfirmSlotButton
      formAction={formAction}
      hiddenInputs={{ bookingId, startUtc }}
      pending={pending}
      error={state?.error}
      timeLabel={label}
      triggerAriaLabel={t("web.myClasses.reschedule.rescheduleToLabel", { label })}
      title={t("web.myClasses.reschedule.confirmTitle")}
      summary={summary}
      subtitle={subtitle}
      confirmLabel={t("web.myClasses.reschedule.confirmLabel")}
      pendingLabel={t("web.myClasses.reschedule.pendingLabel")}
      cancelLabel={t("common.cancel")}
    />
  );
}
