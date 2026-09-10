"use client";

import { useActionState } from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { TESTIMONIAL_BODY_MAX } from "@/lib/testimonials/limits";
import {
  removeStudentTestimonial,
  saveStudentTestimonial,
  type StudentTestimonialState,
} from "@/app/actions/student-testimonials";

const bodyClass =
  "flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// The student's own testimonial, written from inside their account.
//
// The whole point of this form living here rather than behind an emailed link
// is that the session has already proved who is typing. No token to verify, no
// name field to fill in, nothing the teacher could have pre-filled — which is
// what lets the public page make a claim about the result.

export function StudentTestimonialForm({
  teacherId,
  teacherName,
  existingBody,
}: {
  teacherId: string;
  teacherName: string;
  existingBody: string | null;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<StudentTestimonialState, FormData>(
    saveStudentTestimonial,
    undefined,
  );
  const [removeState, removeAction, removing] = useActionState<StudentTestimonialState, FormData>(
    removeStudentTestimonial,
    undefined,
  );

  const hasExisting = existingBody !== null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {hasExisting
          ? t("web.myTeachers.testimonial.control", { name: teacherName })
          : t("web.myTeachers.testimonial.prompt", { name: teacherName })}
      </p>

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="teacherId" value={teacherId} />
        <div className="space-y-1">
          <Label htmlFor="testimonial-body">
            {hasExisting
              ? t("web.myTeachers.testimonial.yours")
              : t("web.myTeachers.testimonial.label")}
          </Label>
          <textarea
            id="testimonial-body"
            name="body"
            required
            rows={4}
            maxLength={TESTIMONIAL_BODY_MAX}
            defaultValue={existingBody ?? ""}
            placeholder={t("web.myTeachers.testimonial.placeholder")}
            className={bodyClass}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? t("web.myTeachers.testimonial.publishing")
              : hasExisting
                ? t("web.myTeachers.testimonial.saveChanges")
                : t("web.myTeachers.testimonial.publish")}
          </Button>
          {state?.ok && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              {t("web.myTeachers.testimonial.saved")}
            </span>
          )}
        </div>
        {state?.error && (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        )}
      </form>

      {hasExisting && (
        <form
          action={removeAction}
          onSubmit={(e) => {
            if (
              !window.confirm(t("web.myTeachers.testimonial.removeConfirm", { name: teacherName }))
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="teacherId" value={teacherId} />
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            {t("web.myTeachers.testimonial.remove")}
          </Button>
          {removeState?.ok && (
            <span className="ml-2 text-sm text-muted-foreground">
              {t("web.myTeachers.testimonial.removed")}
            </span>
          )}
          {removeState?.error && (
            <p className="text-sm text-destructive" role="alert">
              {removeState.error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
