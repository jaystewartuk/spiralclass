"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  setTestAccountAction,
  type TestAccountActionState,
} from "@/app/actions/admin-test-accounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";

/**
 * Mark or unmark a teacher or student as an operator's test account (D-192).
 * One form for both, because it is one flag with one meaning; a reason is
 * required either way and kept on the audit record.
 */
export function TestAccountForm({
  target,
  id,
  testAccount,
}: {
  target: "teacher" | "student";
  id: string;
  testAccount: boolean;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<TestAccountActionState, FormData>(
    setTestAccountAction,
    undefined,
  );
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) toast.success(t("web.admin.testAccount.saved"));
  }, [state, t]);

  return (
    <form action={action} className="space-y-3 rounded-md border p-4">
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="testAccount" value={testAccount ? "false" : "true"} />
      <p className="text-sm text-muted-foreground">
        {t(testAccount ? "web.admin.testAccount.onHint" : "web.admin.testAccount.offHint")}
      </p>
      <div className="space-y-2">
        <Label htmlFor={`test-account-reason-${id}`}>{t("web.admin.moderation.reasonLabel")}</Label>
        <Input id={`test-account-reason-${id}`} name="reason" required maxLength={280} />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {t(testAccount ? "web.admin.testAccount.unmark" : "web.admin.testAccount.mark")}
      </Button>
    </form>
  );
}
