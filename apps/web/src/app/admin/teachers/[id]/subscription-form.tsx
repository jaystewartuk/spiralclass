"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  markSubscriptionComped,
  markSubscriptionPaidManually,
  type AdminSubscriptionState,
} from "@/app/actions/admin-subscriptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";

const PLANS = ["monthly", "annual", "founding"] as const;

// Finance-role plan-status controls, embedded on the teacher detail page.
// Superadmin outranks finance, so this is reachable from /admin/teachers/[id]
// (which is already superadmin-gated).
export function SubscriptionForm({ teacherId }: { teacherId: string }) {
  const t = useT();
  const [compState, compAction, compPending] = useActionState<AdminSubscriptionState, FormData>(
    markSubscriptionComped,
    undefined,
  );
  const [paidState, paidAction, paidPending] = useActionState<AdminSubscriptionState, FormData>(
    markSubscriptionPaidManually,
    undefined,
  );

  useEffect(() => {
    if (compState?.error) toast.error(compState.error);
    else if (compState?.ok) toast.success(t("web.admin.teachers.subscriptionForm.compedToast"));
  }, [compState, t]);
  useEffect(() => {
    if (paidState?.error) toast.error(paidState.error);
    else if (paidState?.ok) toast.success(t("web.admin.teachers.subscriptionForm.paidToast"));
  }, [paidState, t]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form action={compAction} className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">
          {t("web.admin.teachers.subscriptionForm.compTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("web.admin.teachers.subscriptionForm.compHint")}
        </p>
        <input type="hidden" name="teacherId" value={teacherId} />
        <div className="space-y-1">
          <Label htmlFor="comp-plan">{t("web.admin.teachers.planLabel")}</Label>
          <select
            id="comp-plan"
            name="plan"
            defaultValue="founding"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="comp-reason">{t("web.admin.moderation.reasonLabel")}</Label>
          <Input id="comp-reason" name="reason" maxLength={280} />
        </div>
        {compState?.error && <p className="text-sm text-destructive">{compState.error}</p>}
        <Button type="submit" disabled={compPending}>
          {compPending ? "…" : t("web.admin.teachers.subscriptionForm.compSubmit")}
        </Button>
      </form>

      <form action={paidAction} className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">
          {t("web.admin.teachers.subscriptionForm.paidTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("web.admin.teachers.subscriptionForm.paidHint")}
        </p>
        <input type="hidden" name="teacherId" value={teacherId} />
        <div className="space-y-1">
          <Label htmlFor="paid-plan">{t("web.admin.teachers.planLabel")}</Label>
          <select
            id="paid-plan"
            name="plan"
            defaultValue="monthly"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="paid-amount">
            {t("web.admin.teachers.subscriptionForm.amountLabel")}
          </Label>
          <Input id="paid-amount" name="amountMinorUnits" type="number" min={0} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paid-ref">{t("web.admin.teachers.subscriptionForm.wiseRefLabel")}</Label>
          <Input id="paid-ref" name="manualPaymentRef" maxLength={120} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paid-reason">{t("web.admin.moderation.reasonLabel")}</Label>
          <Input id="paid-reason" name="reason" maxLength={280} />
        </div>
        {paidState?.error && <p className="text-sm text-destructive">{paidState.error}</p>}
        <Button type="submit" disabled={paidPending}>
          {paidPending ? "…" : t("web.admin.teachers.subscriptionForm.paidSubmit")}
        </Button>
      </form>
    </div>
  );
}
