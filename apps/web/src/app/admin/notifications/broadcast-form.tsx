"use client";

import { useActionState } from "react";
import {
  sendAdminBroadcastAction,
  type AdminNotificationActionState,
} from "@/app/actions/admin-notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";

// Ad-hoc admin broadcast. Hidden behind a disclosure so it doesn't
// crowd the read-only stats. Superadmin only — also enforced server-side.
export function BroadcastForm() {
  const t = useT();
  const [state, action, pending] = useActionState<AdminNotificationActionState, FormData>(
    sendAdminBroadcastAction,
    undefined,
  );

  return (
    <details className="rounded-md border bg-muted/30 p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {t("web.admin.notifications.sendBroadcast")}
      </summary>
      <form action={action} className="mt-4 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="audience">{t("web.admin.notifications.audience")}</Label>
          <select
            id="audience"
            name="audience"
            required
            defaultValue="teachers"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="teachers">{t("web.admin.notifications.audienceTeachers")}</option>
            <option value="students-active">{t("web.admin.notifications.audienceStudents")}</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="subject">{t("web.admin.notifications.subject")}</Label>
          <Input id="subject" name="subject" required maxLength={150} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="body">{t("web.admin.notifications.bodyLabel")}</Label>
          <Textarea id="body" name="body" required maxLength={5000} rows={8} />
        </div>
        {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state?.info && <p className="text-sm text-success">{state.info}</p>}
        <Button type="submit" disabled={pending}>
          {pending
            ? t("web.admin.notifications.sending")
            : t("web.admin.notifications.sendBroadcast")}
        </Button>
      </form>
    </details>
  );
}
