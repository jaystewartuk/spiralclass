"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/components/locale-provider";

/**
 * Disconnecting Stripe behind a confirmation, because of what it does.
 *
 * It was a bare `<Button type="submit">` sitting directly under the account
 * status, one stray tap from stopping every card payment on her booking page —
 * and, when it is her only rail, from unlisting the page altogether (D-104).
 * That is the most consequential control on this screen and it had the least
 * friction of anything on it.
 *
 * The dialog also carries the sentence the page never said: her Stripe account
 * and the money in it are untouched, because "disconnect" here clears OUR
 * pointer at her account and nothing else. Under D-143 the account is hers,
 * and it cannot be deleted by the platform even deliberately.
 *
 * The server action redirects rather than returning state, so this stays a
 * plain `<form action={…}>` with a `SubmitButton` for the pending signal —
 * `useActionState` would have nothing to hold.
 */
export function DisconnectStripeButton({ action }: { action: () => Promise<void> }) {
  const t = useT();

  return (
    <ConfirmDialog
      trigger={<Button variant="outline">{t("web.settings.payments.disconnect")}</Button>}
      title={t("web.settings.payments.disconnectTitle")}
      footer={(close) => (
        <div className="flex flex-wrap gap-2">
          <form action={action}>
            <SubmitButton variant="destructive">
              {t("web.settings.payments.disconnectConfirm")}
            </SubmitButton>
          </form>
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    >
      <Alert variant="warning">
        <AlertDescription>{t("web.settings.payments.disconnectBody")}</AlertDescription>
      </Alert>
    </ConfirmDialog>
  );
}
