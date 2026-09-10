"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { gradeVocabulary } from "@/app/actions/student-vocab";
import type { Grade } from "@/lib/lesson-notes/srs";
import { useT } from "@/components/locale-provider";

// Phase F, Half 2 (one-term-at-a-time review) + D-97 flashcard study mode: the
// SAME due queue, now shown as a flip card — tap to reveal the confirming
// lesson's evidence/suggestion (attachVocabContext), then grade. Grading
// reschedules the term via the SRS scheduler (server action) and advances
// locally for a snappy pass; flip state resets per card.
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

export function VocabReview({
  terms,
}: {
  terms: { id: string; term: string; context: string | null }[];
}) {
  const t = useT();
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [flipped, setFlipped] = useState(false);
  const [pending, startTransition] = useTransition();

  if (terms.length === 0) return null;
  const remaining = terms.filter((term) => !doneIds.has(term.id));

  if (remaining.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("progress.vocabDone")}</p>;
  }

  const current = remaining[0]!;
  function grade(g: Grade) {
    startTransition(async () => {
      await gradeVocabulary(current.id, g);
      setFlipped(false);
      setDoneIds((prev) => new Set(prev).add(current.id));
    });
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={t(flipped ? "progress.flashcard.showTerm" : "progress.flashcard.flip")}
        className="bg-muted/30 hover:bg-muted/50 flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border px-4 py-6 text-center transition-colors"
      >
        {flipped ? (
          current.context ? (
            <p className="text-sm">{current.context}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{t("progress.flashcard.noContext")}</p>
          )
        ) : (
          <p className="text-lg font-medium">{current.term}</p>
        )}
        <span className="text-muted-foreground text-xs">
          {t(flipped ? "progress.flashcard.showTerm" : "progress.flashcard.flip")}
        </span>
      </button>
      <div className="flex flex-wrap gap-2">
        {GRADE_ORDER.map((g) => (
          <Button key={g} size="sm" variant="outline" disabled={pending} onClick={() => grade(g)}>
            {t(GRADE_KEY[g])}
          </Button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("web.studentProgress.toReviewCount", { count: remaining.length })}
      </p>
    </div>
  );
}
