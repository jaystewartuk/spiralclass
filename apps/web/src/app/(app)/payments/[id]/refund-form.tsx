"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { refundPaymentAction } from "@/app/actions/refund";
import { useT } from "@/components/locale-provider";

export function RefundForm({ paymentId }: { paymentId: string }) {
  const [pending, setPending] = useState(false);
  const t = useT();

  return (
    <div className="space-y-3 rounded-md border p-4">
      <h2 className="font-semibold">{t("web.payments.refundForm.title")}</h2>
      <ConfirmDialog
        trigger={<Button variant="destructive">{t("web.payments.refundForm.title")}</Button>}
        title={t("web.payments.refundForm.confirmTitle")}
        footer={(close) => (
          <>
            <Button type="submit" form="refund-form" variant="destructive" disabled={pending}>
              {pending
                ? t("web.payments.refundForm.processing")
                : t("web.payments.refundForm.confirmRefund")}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        )}
      >
        <Alert variant="warning">
          <AlertDescription>{t("web.payments.refundForm.warning")}</AlertDescription>
        </Alert>
        <form
          id="refund-form"
          action={async (fd) => {
            setPending(true);
            try {
              await refundPaymentAction(fd);
            } finally {
              setPending(false);
            }
          }}
          className="space-y-3 pt-2"
        >
          <input type="hidden" name="paymentId" value={paymentId} />
          <div className="space-y-1">
            <Label htmlFor="reason">{t("web.payments.refundForm.reasonLabel")}</Label>
            <Input id="reason" name="reason" required maxLength={200} aria-required="true" />
          </div>
        </form>
      </ConfirmDialog>
    </div>
  );
}
