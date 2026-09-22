"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { useT } from "@/components/locale-provider";
import { skipActivityAction, type MarketingState } from "@/app/actions/marketing";

/**
 * "Not this one, not this week."
 *
 * It lives here, next to Mark as done, rather than on every row of the weekly
 * list: three controls per row is a wall, and skipping is a decision worth
 * making with the prepared post in front of you. A skip is recorded, not
 * deleted — the next plan reads it as a signal about this kind or this
 * community.
 */
export function SkipButton({ activityId }: { activityId: string }) {
  const t = useT();
  const [state, action, pending] = useActionState<MarketingState, FormData>(
    skipActivityAction,
    undefined,
  );
  return (
    <form action={action}>
      <input type="hidden" name="id" value={activityId} />
      <Button type="submit" variant="ghost" disabled={pending}>
        {t("web.getStudents.skipThis")}
      </Button>
      <FormStatus state={state} />
    </form>
  );
}
