"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { regeneratePlanAction, type MarketingState } from "@/app/actions/marketing";

/** Rebuild this week's plan. Only untouched actions are replaced — anything
 * she already did or skipped stays, so a regenerate can never rewrite her
 * history. */
export function RegeneratePlanButton() {
  const t = useT();
  const [, action, pending] = useActionState<MarketingState, FormData>(
    regeneratePlanAction,
    undefined,
  );
  return (
    <form action={action}>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? t("web.getStudents.regenerating") : t("web.getStudents.regenerate")}
      </Button>
    </form>
  );
}
