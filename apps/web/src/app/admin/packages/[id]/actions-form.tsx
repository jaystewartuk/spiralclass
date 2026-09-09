"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  cancelPackageAction,
  extendPackageExpirationAction,
  type AdminPackageActionState,
} from "@/app/actions/admin-packages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";

export function CancelPackageForm({
  packageId,
  alreadyRefunded,
}: {
  packageId: string;
  alreadyRefunded: boolean;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminPackageActionState, FormData>(
    cancelPackageAction,
    undefined,
  );
  useEffect(() => {
    if (state?.ok) toast.success(t("web.admin.packages.canceledToast"));
    else if (state?.error) toast.error(state.error);
  }, [state, t]);
  if (alreadyRefunded) {
    return (
      <p className="text-sm text-muted-foreground">{t("web.admin.packages.alreadyRefunded")}</p>
    );
  }
  if (state?.ok) return <p className="text-sm text-success">{t("web.admin.packages.canceled")}</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="packageId" value={packageId} />
      <p className="text-sm text-muted-foreground">{t("web.admin.packages.cancelDescription")}</p>
      <div className="space-y-2">
        <Label htmlFor="cancel-reason">{t("web.admin.packages.reasonKeptOnRecord")}</Label>
        <Input id="cancel-reason" name="reason" required maxLength={280} />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? t("web.admin.packages.canceling") : t("web.admin.packages.cancelPackage")}
      </Button>
    </form>
  );
}

export function ExtendPackageForm({
  packageId,
  hasExpiry,
}: {
  packageId: string;
  hasExpiry: boolean;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminPackageActionState, FormData>(
    extendPackageExpirationAction,
    undefined,
  );
  useEffect(() => {
    if (state?.ok) toast.success(t("web.admin.packages.expirationExtendedToast"));
    else if (state?.error) toast.error(state.error);
  }, [state, t]);
  if (!hasExpiry) {
    return <p className="text-sm text-muted-foreground">{t("web.admin.packages.noExpiration")}</p>;
  }
  if (state?.ok)
    return <p className="text-sm text-success">{t("web.admin.packages.expirationExtended")}</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="packageId" value={packageId} />
      <p className="text-sm text-muted-foreground">{t("web.admin.packages.extendDescription")}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="extend-months">{t("web.admin.packages.monthsToExtend")}</Label>
          <Input
            id="extend-months"
            name="months"
            type="number"
            min={1}
            max={24}
            required
            defaultValue={1}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="extend-reason">{t("web.admin.packages.reason")}</Label>
          <Input id="extend-reason" name="reason" required maxLength={280} />
        </div>
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? t("web.admin.packages.extending") : t("web.admin.packages.extendExpiration")}
      </Button>
    </form>
  );
}
