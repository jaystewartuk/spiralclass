"use client";

import { useActionState } from "react";
import { createBooking, type ActionState } from "@/app/actions/booking";
import { ConfirmSlotButton } from "@/components/confirm-slot-button";
import { useT } from "@/components/locale-provider";

// Booking slot: tapping opens a confirmation dialog (review item 2). The
// page formats the full date/time + package summary so the dialog can
// restate exactly what's being booked.
export function SlotSubmitButton({
  packageId,
  startUtc,
  label,
  summary,
  subtitle,
}: {
  packageId: string;
  startUtc: string;
  label: string;
  summary: string;
  subtitle?: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createBooking,
    undefined,
  );

  return (
    <ConfirmSlotButton
      formAction={formAction}
      hiddenInputs={{ packageId, startUtc }}
      pending={pending}
      error={state?.error}
      timeLabel={label}
      triggerAriaLabel={t("web.myClasses.book.bookAtLabel", { label })}
      title={t("book.confirmAsk.title")}
      summary={summary}
      subtitle={subtitle}
      confirmLabel={t("book.confirmAsk.cta")}
      pendingLabel={t("web.myClasses.book.bookingPending")}
      cancelLabel={t("common.cancel")}
    />
  );
}
