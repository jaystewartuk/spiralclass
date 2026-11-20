"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { gradeVocabulary } from "@/app/actions/student-vocab";
import type { Grade } from "@/lib/lesson-notes/srs";
import { useT } from "@/components/locale-provider";
import type { DueCard } from "@/lib/lesson-notes/student-progress";

// Phase F, Half 2: the student's due queue, one term at a time. The card is the
// term alone — she recalls what it means and how to use it, then grades
// herself, and grading reschedules the term via the SRS scheduler (server
// action) and advances locally for a snappy pass. There is no back to flip to:
// the only text stored beside a term is the teacher's insight note, which is
// written to the teacher and never shown here (#302,
// docs/features/lesson-insights-reports.md, "What the student sees").
const GRADE_KEY: Record<
  Grade,
  "progress.grade.again" | "progress.grade.hard" | "progress.grade.good" | "progress.grade.easy"
> = {
  again: "progress.grade.again",
  hard: "progress.grade.hard",
  good: "progress.grade.good",
  easy: "progress.grade.easy",
};
const GRADE_ORDER: Grade[] = ["again", "hard", "good", "easy"];

export function VocabReview({ terms }: { terms: DueCard[] }) {
  const t = useT();
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  if (terms.length === 0) return null;
  const remaining = terms.filter((term) => !doneIds.has(term.id));

  if (remaining.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("progress.vocabDone")}</p>;
  }

  const current = remaining[0]!;
  function grade(g: Grade) {
    startTransition(async () => {
      await gradeVocabulary(current.id, g);
      setDoneIds((prev) => new Set(prev).add(current.id));
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border bg-muted/30 px-4 py-6 text-center">
        <p className="text-lg font-medium">{current.term}</p>
        <p className="text-xs text-muted-foreground">{t("progress.flashcard.recall")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {GRADE_ORDER.map((g) => (
          <Button key={g} size="sm" variant="outline" disabled={pending} onClick={() => grade(g)}>
            {t(GRADE_KEY[g])}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("web.studentProgress.toReviewCount", { count: remaining.length })}
      </p>
    </div>
  );
}
