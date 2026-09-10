"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  adminRefundPaymentAction,
  type AdminPaymentActionState,
} from "@/app/actions/admin-payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/components/locale-provider";

// Two-step in-row refund control. Opens a ConfirmDialog with a reason input +
// the destructive confirm button. The dialog is closed on success.
export function RefundButton({ paymentId, disabled }: { paymentId: string; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AdminPaymentActionState, FormData>(
    adminRefundPaymentAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(
        t("web.admin.payments.refundedToast", { id: state.refundId?.slice(0, 12) ?? "" }),
      );
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state, t]);

  // Close the dialog when the action succeeds
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
    }
  }, [state?.ok]);

  if (state?.ok) {
    return (
      <span className="text-success text-xs">
        {t("web.admin.payments.refundedToast", { id: state.refundId?.slice(0, 12) ?? "" })}
      </span>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {t("web.admin.payments.refund")}
        </Button>
      }
      title={t("web.admin.payments.refundConfirmTitle")}
      footer={(close) => (
        <>
          <Button
            type="submit"
            form="admin-refund-form"
            variant="destructive"
            size="sm"
            disabled={pending}
          >
            {pending ? t("web.admin.payments.refunding") : t("web.admin.payments.confirmRefund")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            {t("common.cancel")}
          </Button>
        </>
      )}
    >
      <form id="admin-refund-form" action={action} className="space-y-3">
        <input type="hidden" name="paymentId" value={paymentId} />
        <Input
          name="reason"
          required
          maxLength={280}
          aria-required="true"
          placeholder={t("web.admin.payments.reasonForRefund")}
          className="h-8 text-xs"
        />
        {state?.error && <span className="text-destructive text-xs">{state.error}</span>}
      </form>
    </ConfirmDialog>
  );
}
