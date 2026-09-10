"use client";

import { useActionState } from "react";
import {
  markSubscriptionPaidManually,
  type AdminSubscriptionState,
} from "@/app/actions/admin-subscriptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/locale-provider";
import type { SubscriptionPlan } from "@/lib/subscriptions/config";

// Inline "mark this cycle paid" form for a single Wise renewal-due row (admin
// /subscriptions page). Wraps markSubscriptionPaidManually — the manual/Wise
// rail stub — so the admin can act on the renewals worklist without leaving
// the page. Prefills plan + amount from the subscription's locked price;
// manualPaymentRef is optional (the teacher's Wise transfer reference, if given).
export function WiseRenewalForm({
  teacherId,
  plan,
  lockedPriceMinorUnits,
}: {
  teacherId: string;
  plan: SubscriptionPlan;
  lockedPriceMinorUnits: number | null;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminSubscriptionState, FormData>(
    markSubscriptionPaidManually,
    undefined,
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="teacherId" value={teacherId} />
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="amountMinorUnits" value={lockedPriceMinorUnits ?? 0} />
      <Input
        name="manualPaymentRef"
        placeholder={t("web.admin.subscriptions.wiseReferencePlaceholder")}
        className="h-8 w-48 text-xs"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || !lockedPriceMinorUnits}
      >
        {pending ? t("common.loading") : t("web.admin.subscriptions.markPaid")}
      </Button>
      {state?.error && <span className="text-destructive text-xs">{state.error}</span>}
      {state?.ok && (
        <span className="text-success text-xs">{t("web.admin.subscriptions.recorded")}</span>
      )}
    </form>
  );
}
