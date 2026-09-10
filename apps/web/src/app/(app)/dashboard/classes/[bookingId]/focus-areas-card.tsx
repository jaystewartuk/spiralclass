"use client";

import { useState, useTransition } from "react";
import type { InsightCategory } from "@prisma/client";
import type { TFunction, StringKey } from "@/lib/i18n-translate";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { SKILLS, skillLabel, suggestSkill } from "@/lib/lesson-notes/skills";
import {
  addInsight,
  confirmInsight,
  dismissInsight,
  editInsight,
} from "@/app/actions/lesson-insights";
import { useT } from "@/components/locale-provider";

// Phase E interactive review. C's
// read-only "Focus areas" card becomes the teacher's ~10-second validation pass:
// Confirm / Edit / Dismiss each AI finding, Add her own. Only confirmed (or
// teacher-authored) rows feed the longitudinal profile — the server actions own
// that + the Pro gate + the recompute; this is just the surface.

export type FocusAreaItem = {
  id: string;
  category: InsightCategory;
  summary: string;
  evidence: string | null;
  suggestion: string | null;
  atMs: number | null;
  source: string; // "ai" | "teacher"
  confirmed: boolean;
  skill: string | null;
};

const CATEGORY_ORDER: InsightCategory[] = [
  "pronunciation",
  "grammar",
  "vocabulary",
  "fluency",
  "comprehension",
];
const CATEGORY_LABEL_KEY: Record<InsightCategory, StringKey> = {
  pronunciation: "insights.cat.pronunciation",
  grammar: "insights.cat.grammar",
  vocabulary: "insights.cat.vocabulary",
  fluency: "insights.cat.fluency",
  comprehension: "insights.cat.comprehension",
};

// Skill <select> options for a category: the taxonomy plus whatever value is
// already chosen (so a free-form/fallback skill stays selectable).
function skillOptions(category: InsightCategory, current: string): string[] {
  const base = SKILLS[category] ?? [];
  return base.includes(current) || !current ? base : [current, ...base];
}

export function FocusAreasCard({
  bookingId,
  insights,
}: {
  bookingId: string;
  insights: FocusAreaItem[];
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Render nothing when there are no findings to review.
  if (insights.length === 0 && !adding) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("insights.title")}</CardTitle>
          <CardDescription>{t("insights.empty")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            {t("insights.addOwn")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  function run(action: () => Promise<{ error?: string; ok?: boolean }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (res?.error) setError(res.error);
      else {
        setEditingId(null);
        setAdding(false);
      }
    });
  }

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: insights.filter((i) => i.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("insights.title")}</CardTitle>
        <CardDescription>{t("insights.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-destructive text-sm">{error}</p>}

        {grouped.map(({ category, items }) => (
          <div key={category} className="space-y-2">
            <h4 className="text-muted-foreground text-sm font-medium">
              {t(CATEGORY_LABEL_KEY[category])}
            </h4>
            <ul className="space-y-3">
              {items.map((item) =>
                editingId === item.id ? (
                  <EditRow
                    key={item.id}
                    item={item}
                    t={t}
                    pending={pending}
                    onCancel={() => setEditingId(null)}
                    onSave={(input) => run(() => editInsight(item.id, input))}
                  />
                ) : (
                  <ReviewRow
                    key={item.id}
                    item={item}
                    t={t}
                    pending={pending}
                    onConfirm={(skill) => run(() => confirmInsight(item.id, skill))}
                    onDismiss={() => run(() => dismissInsight(item.id))}
                    onEdit={() => setEditingId(item.id)}
                  />
                ),
              )}
            </ul>
          </div>
        ))}

        {adding ? (
          <AddRow
            t={t}
            pending={pending}
            onCancel={() => setAdding(false)}
            onAdd={(input) => run(() => addInsight(bookingId, input))}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            {`+ ${t("insights.addOwn")}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewRow({
  item,
  t,
  pending,
  onConfirm,
  onDismiss,
  onEdit,
}: {
  item: FocusAreaItem;
  t: TFunction;
  pending: boolean;
  onConfirm: (skill: string) => void;
  onDismiss: () => void;
  onEdit: () => void;
}) {
  const [skill, setSkill] = useState(item.skill || suggestSkill(item.category, item.summary));

  return (
    <li className="border-muted space-y-1 border-l-2 pl-3 text-sm">
      <div className="flex items-center gap-2">
        <p className="font-medium">{item.summary}</p>
        {item.confirmed && <Badge variant="secondary">{`✓ ${t("insights.confirmed")}`}</Badge>}
        {item.source === "teacher" && !item.confirmed && (
          <Badge variant="outline">{t("web.dashboard.classes.focusAreas.yours")}</Badge>
        )}
      </div>
      {item.evidence && <p className="text-muted-foreground">“{item.evidence}”</p>}
      {item.suggestion && (
        <p>
          <span className="text-muted-foreground">{t("web.dashboard.classes.focusAreas.try")}</span>
          {item.suggestion}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!item.confirmed && (
          <>
            <select
              aria-label={t("web.dashboard.classes.focusAreas.skill")}
              className="border-input bg-background h-8 rounded-md border px-2 text-xs"
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            >
              {skillOptions(item.category, skill).map((s) => (
                <option key={s} value={s}>
                  {skillLabel(t, s)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => onConfirm(skill)}
            >
              {t("insights.confirm")}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={onEdit}>
          {t("common.edit")}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>
          {t("insights.dismiss")}
        </Button>
      </div>
    </li>
  );
}

type EditInput = {
  summary: string;
  suggestion: string | null;
  category: InsightCategory;
  skill: string;
};

function EditRow({
  item,
  t,
  pending,
  onCancel,
  onSave,
}: {
  item: FocusAreaItem;
  t: TFunction;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: EditInput) => void;
}) {
  const [summary, setSummary] = useState(item.summary);
  const [suggestion, setSuggestion] = useState(item.suggestion ?? "");
  const [category, setCategory] = useState<InsightCategory>(item.category);
  const [skill, setSkill] = useState(item.skill || suggestSkill(item.category, item.summary));
  const [summaryError, setSummaryError] = useState<string | undefined>(undefined);

  function save() {
    if (!summary.trim()) {
      setSummaryError(t("web.dashboard.classes.focusAreas.required"));
      return;
    }
    setSummaryError(undefined);
    onSave({ summary: summary.trim(), suggestion: suggestion.trim() || null, category, skill });
  }

  return (
    <li className="border-primary space-y-2 border-l-2 pl-3 text-sm">
      <Textarea
        value={summary}
        onChange={(e) => {
          setSummary(e.target.value);
          setSummaryError(undefined);
        }}
        rows={2}
        invalid={Boolean(summaryError)}
        aria-describedby={summaryError ? `edit-summary-error-${item.id}` : undefined}
      />
      <FieldError id={`edit-summary-error-${item.id}`} message={summaryError} />
      <Input
        value={suggestion}
        placeholder={t("web.dashboard.classes.focusAreas.suggestionPlaceholder")}
        onChange={(e) => setSuggestion(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t("web.dashboard.classes.focusAreas.category")}
          className="border-input bg-background h-8 rounded-md border px-2 text-xs"
          value={category}
          onChange={(e) => setCategory(e.target.value as InsightCategory)}
        >
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {t(CATEGORY_LABEL_KEY[c])}
            </option>
          ))}
        </select>
        <select
          aria-label={t("web.dashboard.classes.focusAreas.skill")}
          className="border-input bg-background h-8 rounded-md border px-2 text-xs"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
        >
          {skillOptions(category, skill).map((s) => (
            <option key={s} value={s}>
              {skillLabel(t, s)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={save}>
          {t("web.dashboard.classes.focusAreas.saveAndConfirm")}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </li>
  );
}

type AddInput = {
  category: InsightCategory;
  summary: string;
  suggestion: string | null;
  skill: string;
};

function AddRow({
  t,
  pending,
  onCancel,
  onAdd,
}: {
  t: TFunction;
  pending: boolean;
  onCancel: () => void;
  onAdd: (input: AddInput) => void;
}) {
  const [category, setCategory] = useState<InsightCategory>("grammar");
  const [summary, setSummary] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [summaryError, setSummaryError] = useState<string | undefined>(undefined);

  function add() {
    const trimmed = summary.trim();
    if (!trimmed) {
      setSummaryError(t("web.dashboard.classes.focusAreas.required"));
      return;
    }
    setSummaryError(undefined);
    onAdd({
      category,
      summary: trimmed,
      suggestion: suggestion.trim() || null,
      skill: suggestSkill(category, trimmed),
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
      <p className="font-medium">{t("web.dashboard.classes.focusAreas.addTitle")}</p>
      <select
        aria-label={t("web.dashboard.classes.focusAreas.category")}
        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
        value={category}
        onChange={(e) => setCategory(e.target.value as InsightCategory)}
      >
        {CATEGORY_ORDER.map((c) => (
          <option key={c} value={c}>
            {t(CATEGORY_LABEL_KEY[c])}
          </option>
        ))}
      </select>
      <Textarea
        value={summary}
        placeholder={t("insights.addPlaceholder")}
        onChange={(e) => {
          setSummary(e.target.value);
          setSummaryError(undefined);
        }}
        rows={2}
        invalid={Boolean(summaryError)}
        aria-describedby={summaryError ? "add-summary-error" : undefined}
      />
      <FieldError id="add-summary-error" message={summaryError} />
      <Input
        value={suggestion}
        placeholder={t("web.dashboard.classes.focusAreas.suggestionPlaceholder")}
        onChange={(e) => setSuggestion(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={add}>
          {t("insights.add")}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
