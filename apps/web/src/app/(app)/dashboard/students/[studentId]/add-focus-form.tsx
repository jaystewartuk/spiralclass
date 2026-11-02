"use client";

import { useState, useTransition } from "react";
import type { InsightCategory } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { suggestSkill } from "@/lib/lesson-notes/skills";
import { addInsight } from "@/app/actions/lesson-insights";
import { useT } from "@/components/locale-provider";
import type { StringKey } from "@/lib/i18n-translate";

const CATEGORIES: { value: InsightCategory; key: StringKey }[] = [
  { value: "grammar", key: "web.studentProfile.category.grammar" },
  { value: "pronunciation", key: "web.studentProfile.category.pronunciation" },
  { value: "vocabulary", key: "web.studentProfile.category.vocabulary" },
  { value: "fluency", key: "web.studentProfile.category.fluency" },
  { value: "comprehension", key: "web.studentProfile.category.comprehension" },
];

// A teacher-authored focus area, written from the student's profile rather than
// from a class page. It goes through the same `addInsight` action as the class
// card (source "teacher", confirmed on creation, profile recomputed), attached
// to the student's most recent class because every finding belongs to one.
export function AddFocusForm({ bookingId }: { bookingId: string }) {
  const t = useT();
  const [category, setCategory] = useState<InsightCategory>("grammar");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = summary.trim();
    if (!trimmed) {
      setError(t("web.dashboard.classes.focusAreas.required"));
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const res = await addInsight(bookingId, {
        category,
        summary: trimmed,
        skill: suggestSkill(category, trimmed),
      });
      if (res.error) setError(res.error);
      else setSummary("");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <p className="text-sm font-medium">{t("web.studentProfile.addTitle")}</p>
      <select
        aria-label={t("web.dashboard.classes.focusAreas.category")}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={category}
        onChange={(e) => setCategory(e.target.value as InsightCategory)}
      >
        {CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {t(c.key)}
          </option>
        ))}
      </select>
      <Textarea
        value={summary}
        placeholder={t("insights.addPlaceholder")}
        onChange={(e) => {
          setSummary(e.target.value);
          setError(undefined);
        }}
        rows={2}
        invalid={Boolean(error)}
        aria-describedby={error ? "add-focus-error" : undefined}
      />
      <FieldError id="add-focus-error" message={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {t("insights.add")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("web.studentProfile.addNote")}</p>
      </div>
    </form>
  );
}
