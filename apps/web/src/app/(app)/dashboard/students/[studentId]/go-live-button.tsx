"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setStudentLiveAction, type RosterActionState } from "@/app/actions/teacher-students";
import { useT } from "@/components/locale-provider";

// "Go live" for a silently-onboarded student: clears the notification hold so
// confirmations, reminders and nudges start flowing. One-way and confirmed —
// to silence a live student again the teacher archives them instead.
export function GoLiveButton({ studentId }: { studentId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState<RosterActionState, FormData>(
    setStudentLiveAction,
    undefined,
  );

  return (
    <form
      action={formAction}
      className="space-y-3"
      onSubmit={(e) => {
        const message = t("web.dashboard.students.goLive.confirm");
        if (!confirm(message)) e.preventDefault();
      }}
    >
      <input type="hidden" name="studentId" value={studentId} />
      <Button type="submit" disabled={pending}>
        {pending ? "…" : t("web.dashboard.students.goLive.button")}
      </Button>
      {state?.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-success text-sm">
          {state.ok}
        </p>
      )}
    </form>
  );
}
