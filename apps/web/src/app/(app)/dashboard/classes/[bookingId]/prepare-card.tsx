"use client";

import { useActionState } from "react";
import type { InsightCategory } from "@prisma/client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createLessonNote, type LessonNoteState } from "@/app/actions/lesson-notes";
import { useT } from "@/components/locale-provider";
import type { TFunction, StringKey } from "@/lib/i18n-translate";

// Phase F "Prepare for this class".
// The pre-class brief built from the student's learning profile, shown on the
// UPCOMING booking. Each suggested cue can be staged into the live notes with one
// tap — reusing createLessonNote (audience="teacher"), the same cue mechanism the
// live class surface uses. A suggestion is ephemeral until the teacher accepts it;
// once added it's an ordinary teacher cue. Clearly AI-suggested.

export type BriefFocusItem = {
  skill: string;
  category: InsightCategory;
  why: string;
  suggestedCue: string;
};
export type BriefContent = {
  summary: string;
  focus: BriefFocusItem[];
  vocabulary: string[];
};

const CATEGORY_LABEL_KEY: Record<string, StringKey> = {
  pronunciation: "insights.cat.pronunciation",
  grammar: "insights.cat.grammar",
  vocabulary: "insights.cat.vocabulary",
  fluency: "insights.cat.fluency",
  comprehension: "insights.cat.comprehension",
};

export function PrepareCard({ bookingId, brief }: { bookingId: string; brief: BriefContent }) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.classes.prepare.title")}</CardTitle>
        <CardDescription>{t("web.dashboard.classes.prepare.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {brief.summary && <p>{brief.summary}</p>}

        {brief.focus.length > 0 && (
          <ul className="space-y-3">
            {brief.focus.map((f, i) => (
              <li key={`${f.skill}-${i}`} className="space-y-1 border-l-2 border-muted pl-3">
                <p className="font-medium">
                  {f.skill.replace(/_/g, " ")}{" "}
                  <span className="font-normal text-muted-foreground">
                    ·{" "}
                    {CATEGORY_LABEL_KEY[f.category]
                      ? t(CATEGORY_LABEL_KEY[f.category]!)
                      : f.category}
                  </span>
                </p>
                {f.why && <p className="text-muted-foreground">{f.why}</p>}
                <AddCue bookingId={bookingId} body={f.suggestedCue} t={t} />
              </li>
            ))}
          </ul>
        )}

        {brief.vocabulary.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-sm font-medium text-muted-foreground">
              {t("web.dashboard.classes.prepare.vocabulary")}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {brief.vocabulary.map((term) => (
                <Badge key={term} variant="outline">
                  {term}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// One suggested cue + its "Add as cue" action. Reuses createLessonNote, so the
// cue lands in the same teacher live-notes column the class surface reads.
function AddCue({ bookingId, body, t }: { bookingId: string; body: string; t: TFunction }) {
  const [state, formAction, pending] = useActionState<LessonNoteState, FormData>(
    createLessonNote,
    undefined,
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="flex-1 text-muted-foreground">“{body}”</p>
      {state?.ok ? (
        <Badge variant="secondary">{`✓ ${t("web.dashboard.classes.prepare.addedToNotes")}`}</Badge>
      ) : (
        <form action={formAction}>
          <input type="hidden" name="bookingId" value={bookingId} />
          <input type="hidden" name="audience" value="teacher" />
          <input type="hidden" name="body" value={body} />
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            {pending ? t("lessonNotes.adding") : t("web.dashboard.classes.prepare.addAsCue")}
          </Button>
        </form>
      )}
      {state?.error && <p className="w-full text-destructive">{state.error}</p>}
    </div>
  );
}
