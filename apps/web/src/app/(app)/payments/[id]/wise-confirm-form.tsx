"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmTransferPaymentAction, failWisePaymentAction } from "@/app/actions/wise-confirm";
import { useT } from "@/components/locale-provider";

// Teacher-side confirmation widget on /payments/[id] for Wise-provider
// payments still in `pending`. Two actions on the same form:
//   * "Marcar como recibido" → confirmTransferPaymentAction
//   * "Marcar como no recibido" → failWisePaymentAction
//
// We use the formAction attribute on each button to dispatch to the
// right action without juggling nested forms.
export function WiseConfirmForm({
  paymentId,
  reference,
}: {
  paymentId: string;
  reference: string | null;
}) {
  const [pending, setPending] = useState(false);
  const t = useT();

  return (
    <form className="space-y-3 rounded-md border p-4" onSubmit={() => setPending(true)}>
      <input type="hidden" name="paymentId" value={paymentId} />
      <h2 className="font-semibold">{t("web.payments.transferConfirm.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {reference ? (
          <>
            {t("web.payments.transferConfirm.bodyWithReferencePrefix")}{" "}
            <span className="font-mono">{reference}</span>
            {t("web.payments.transferConfirm.bodyWithReferenceSuffix")}
          </>
        ) : (
          t("web.payments.transferConfirm.bodyNoReference")
        )}
      </p>
      <div className="space-y-1">
        <Label htmlFor="wise-note">{t("web.payments.transferConfirm.noteLabel")}</Label>
        <Input
          id="wise-note"
          name="note"
          maxLength={200}
          placeholder={t("web.payments.transferConfirm.notePlaceholder")}
          disabled={pending}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" formAction={confirmTransferPaymentAction} disabled={pending}>
          {pending
            ? t("web.payments.refundForm.processing")
            : t("web.payments.transferConfirm.markReceived")}
        </Button>
        <Button
          type="submit"
          variant="outline"
          formAction={failWisePaymentAction}
          disabled={pending}
        >
          {t("web.payments.transferConfirm.markNotReceived")}
        </Button>
      </div>
    </form>
  );
}
