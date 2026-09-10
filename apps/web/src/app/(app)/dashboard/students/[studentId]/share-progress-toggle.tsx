"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setShareProgress } from "@/app/actions/student-progress";
import { useT } from "@/components/locale-provider";

// Phase F, Half 2: the teacher's per-student switch to share the learning
// profile with the student in their app. Off by default — sharing is
// deliberate.
//
// The two labels were inline `en ? "…" : "…"` ternaries, which is the pattern
// the key-based catalog replaced: they were the only strings on this screen a
// French teacher saw in Spanish.
export function ShareProgressToggle({ studentId, shared }: { studentId: string; shared: boolean }) {
  const t = useT();
  const [on, setOn] = useState(shared);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setError(null);
    startTransition(async () => {
      const res = await setShareProgress(studentId, next);
      if (res.error) setError(res.error);
      else setOn(next);
    });
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant={on ? "secondary" : "outline"}
        disabled={pending}
        aria-pressed={on}
        onClick={toggle}
      >
        {on && <Check className="size-4" aria-hidden />}
        {on ? t("web.studentProfile.shared") : t("web.studentProfile.share")}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
