"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { togglePackagePauseAction, type PackagePauseState } from "@/app/actions/packages";
import { useT } from "@/components/locale-provider";

// Pause/resume control for a single package on the teacher's student detail
// page. Only rendered for packages in a toggleable state (active → pause,
// paused → resume); the server action re-checks the transition.
export function PackagePauseButton({
  packageId,
  status,
}: {
  packageId: string;
  status: "active" | "paused";
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<PackagePauseState, FormData>(
    togglePackagePauseAction,
    undefined,
  );
  const intent = status === "active" ? "pause" : "resume";
  const label =
    intent === "pause"
      ? t("web.dashboard.students.package.pause")
      : t("web.dashboard.students.package.resume");

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="packageId" value={packageId} />
      <input type="hidden" name="intent" value={intent} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "..." : label}
      </Button>
      {state?.error && (
        <span role="alert" className="text-destructive text-xs">
          {state.error}
        </span>
      )}
    </form>
  );
}
