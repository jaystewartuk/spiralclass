"use client";

import { useActionState } from "react";
import {
  retryNotificationAction,
  type AdminNotificationActionState,
} from "@/app/actions/admin-notifications";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";

export function RetryButton({ notificationId }: { notificationId: string }) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminNotificationActionState, FormData>(
    retryNotificationAction,
    undefined,
  );

  if (state?.ok)
    return <span className="text-xs text-success">{t("web.admin.notifications.requeued")}</span>;
  return (
    <form action={action} className="inline">
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "…" : t("common.retry")}
      </Button>
      {state?.error && <span className="ml-2 text-xs text-destructive">{state.error}</span>}
    </form>
  );
}
