"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { generateLessonSummary, type LessonNoteState } from "@/app/actions/lesson-notes";
import { useT } from "@/components/locale-provider";

// AI post-class summary (live-notes-panel.md "step 2", D-15). Teacher-private:
// a one-tap recap built from the class's live notes. The Pro gate lives on the
// action, so a Free teacher still sees the button and gets the upgrade nudge.
export function LessonSummaryCard({
  bookingId,
  summary,
  hasNotes,
}: {
  bookingId: string;
  summary: { body: string; generatedAt: string } | null;
  hasNotes: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<LessonNoteState, FormData>(
    generateLessonSummary,
    undefined,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.classes.summary.title")}</CardTitle>
        <CardDescription>{t("web.dashboard.classes.summary.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary ? (
          <>
            {/* Notes can hold newlines; preserve them. */}
            <p className="text-sm whitespace-pre-wrap">{summary.body}</p>
            <p className="text-muted-foreground text-xs">
              {t("web.dashboard.classes.summary.generated")}
              {summary.generatedAt}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            {hasNotes
              ? t("web.dashboard.classes.summary.none")
              : t("web.dashboard.classes.summary.needsNotes")}
          </p>
        )}

        <form action={formAction}>
          <input type="hidden" name="bookingId" value={bookingId} />
          {state?.error && <p className="text-destructive mb-2 text-sm">{state.error}</p>}
          <Button type="submit" size="sm" variant="secondary" disabled={pending || !hasNotes}>
            {pending
              ? t("web.dashboard.classes.summary.generating")
              : summary
                ? t("web.dashboard.classes.summary.regenerate")
                : t("web.dashboard.classes.summary.generate")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
