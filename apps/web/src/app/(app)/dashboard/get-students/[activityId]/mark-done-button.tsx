"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { markActivityDoneAction, type MarketingState } from "@/app/actions/marketing";

/** "I posted it." This is the moment the loop closes: from here on, anything
 * the tracked link produces is attributed to this action. */
export function MarkDoneButton({ activityId }: { activityId: string }) {
  const t = useT();
  const [, action, pending] = useActionState<MarketingState, FormData>(
    markActivityDoneAction,
    undefined,
  );
  return (
    <form action={action}>
      <input type="hidden" name="id" value={activityId} />
      <Button type="submit" disabled={pending}>
        {t("web.getStudents.markDone")}
      </Button>
    </form>
  );
}
