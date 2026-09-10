"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { setStudentProfile } from "@/app/actions/student-profile";
import { type StudentProfileState, STUDENT_PROFILE_MAX_CHARS } from "@/lib/student-profile-fields";
import { useT } from "@/components/locale-provider";

// Layer 1 — durable student profile (interests + goals). These feed every AI
// class-content generation, so the teacher sets the "who" once instead of
// re-typing it into a prompt each class. Teacher-private.

export function StudentProfileForm({
  studentId,
  interests,
  goals,
}: {
  studentId: string;
  interests: string | null;
  goals: string | null;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<StudentProfileState, FormData>(
    setStudentProfile,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="studentId" value={studentId} />

      <div className="space-y-1">
        <Label htmlFor="studentGoals">{t("web.studentProfileForm.goalLabel")}</Label>
        <Textarea
          id="studentGoals"
          name="goals"
          defaultValue={goals ?? ""}
          rows={2}
          maxLength={STUDENT_PROFILE_MAX_CHARS}
          placeholder={t("web.studentProfileForm.goalPlaceholder")}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="studentInterests">{t("web.studentProfileForm.interestsLabel")}</Label>
        <Textarea
          id="studentInterests"
          name="interests"
          defaultValue={interests ?? ""}
          rows={2}
          maxLength={STUDENT_PROFILE_MAX_CHARS}
          placeholder={t("web.studentProfileForm.interestsPlaceholder")}
        />
        <p className="text-muted-foreground text-xs">{t("web.studentProfileForm.hint")}</p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? t("web.studentLevel.saving") : t("common.save")}
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
