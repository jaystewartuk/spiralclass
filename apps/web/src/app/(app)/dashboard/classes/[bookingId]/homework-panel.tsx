"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/components/locale-provider";
import {
  createAssignmentAction,
  deleteAssignmentAction,
  type CreateAssignmentState,
} from "@/app/actions/homework";

// The teacher's assignments panel — authoring-only scope (list/create/delete;
// the review/grading surface is a later slice), on the shared
// homework.teacher.* i18n namespace so there's no parallel copy to keep in
// sync.

export type HomeworkAssignmentRow = {
  id: string;
  title: string;
  dueAtLabel: string | null;
  submissionCount: number;
};

export function HomeworkPanel({
  bookingId,
  assignments,
}: {
  bookingId: string;
  assignments: HomeworkAssignmentRow[];
}) {
  const t = useT();
  const [showForm, setShowForm] = useState(false);
  const [hasDue, setHasDue] = useState(false);
  const [allowLate, setAllowLate] = useState(true);
  const [allowResubmit, setAllowResubmit] = useState(false);
  const [state, formAction, pending] = useActionState<CreateAssignmentState, FormData>(
    createAssignmentAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      setShowForm(false);
      setHasDue(false);
      setAllowLate(true);
      setAllowResubmit(false);
    }
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("homework.teacher.title")}</CardTitle>
        <CardDescription>{t("homework.teacher.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("homework.teacher.empty")}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium">{a.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.dueAtLabel ? `${a.dueAtLabel} · ` : ""}
                    {a.submissionCount > 0
                      ? t("homework.teacher.submissionCount", { count: String(a.submissionCount) })
                      : t("homework.teacher.noSubmissions")}
                  </p>
                </div>
                {a.submissionCount > 0 && (
                  <Button asChild type="button" variant="outline" size="sm">
                    <Link href={`/dashboard/classes/${bookingId}/homework/${a.id}`}>
                      {t("homework.teacher.review")}
                    </Link>
                  </Button>
                )}
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="ghost" size="sm">
                      {t("common.delete")}
                    </Button>
                  }
                  title={t("homework.teacher.deleteConfirmTitle")}
                  description={t("homework.teacher.deleteConfirmMessage")}
                  footer={(close) => (
                    <>
                      <Button type="button" variant="outline" onClick={close}>
                        {t("common.cancel")}
                      </Button>
                      <form action={deleteAssignmentAction}>
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <input type="hidden" name="bookingId" value={bookingId} />
                        <Button type="submit" variant="destructive">
                          {t("common.delete")}
                        </Button>
                      </form>
                    </>
                  )}
                />
              </li>
            ))}
          </ul>
        )}

        {showForm ? (
          <form action={formAction} className="space-y-3 rounded-md border bg-muted/40 p-3">
            <input type="hidden" name="bookingId" value={bookingId} />
            <div className="space-y-1">
              <Label htmlFor="hw-title">{t("homework.teacher.titleLabel")}</Label>
              <Input id="hw-title" name="title" required maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hw-instructions">{t("homework.teacher.instructionsLabel")}</Label>
              <Textarea id="hw-instructions" name="instructions" maxLength={5000} rows={3} />
            </div>
            <div className="space-y-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={hasDue} onCheckedChange={(v) => setHasDue(v === true)} />
                {t("homework.teacher.setDue")}
              </label>
              {hasDue && (
                <div className="space-y-1">
                  <Label htmlFor="hw-due">{t("homework.teacher.dueLabel")}</Label>
                  <Input id="hw-due" type="datetime-local" name="dueAt" required />
                </div>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allowLate} onCheckedChange={(v) => setAllowLate(v === true)} />
              {t("homework.teacher.allowLate")}
            </label>
            <input type="hidden" name="allowLateSubmission" value={String(allowLate)} />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={allowResubmit}
                onCheckedChange={(v) => setAllowResubmit(v === true)}
              />
              {t("homework.teacher.allowResubmit")}
            </label>
            <input type="hidden" name="allowResubmission" value={String(allowResubmit)} />
            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" disabled={pending}>
                {t("homework.teacher.save")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                {t("common.cancel")}
              </Button>
            </div>
            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          </form>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setShowForm(true)}>
            {t("homework.teacher.add")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
