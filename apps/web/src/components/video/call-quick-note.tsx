"use client";

import { useEffect, useRef, useState } from "react";
import type { InsightCategory } from "@prisma/client";
import { useT } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

// The teacher's in-call quick note: one line, one tap, saved as a confirmed
// focus area of her own for THIS class (source "teacher"), so it reaches the
// student's learning profile and the next pre-class brief instead of living in
// a notes column she has to remember to read. It is the same write path as
// "add your own finding" on the class page (addInsightFor) — the call only
// shortens the walk to it.
//
// Teacher-only by construction: the call page passes `onQuickNote` for the
// teacher and the student's page never does, and nothing here reaches the
// room (no data message, no LiveKit attribute).

export type QuickNoteInput = {
  category: InsightCategory;
  summary: string;
  skill?: string;
};

export type QuickNoteResult = { ok?: boolean; error?: string };

const CATEGORIES: InsightCategory[] = [
  "grammar",
  "vocabulary",
  "pronunciation",
  "fluency",
  "comprehension",
];

const CATEGORY_LABEL_KEY = {
  pronunciation: "insights.cat.pronunciation",
  grammar: "insights.cat.grammar",
  vocabulary: "insights.cat.vocabulary",
  fluency: "insights.cat.fluency",
  comprehension: "insights.cat.comprehension",
} as const;

export function CallQuickNote({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: QuickNoteInput) => Promise<QuickNoteResult>;
}) {
  const t = useT();
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<InsightCategory>("grammar");
  const [skill, setSkill] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the field on open: the point is to type the moment it appears. The
  // call's single-key shortcuts ignore a focused field (class-call.tsx), so
  // typing "movie" here cannot mute her.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  if (!open) return null;

  async function save() {
    const trimmed = summary.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await onSubmit({
        category,
        summary: trimmed,
        ...(skill.trim() ? { skill: skill.trim() } : {}),
      });
      if (res.error || res.ok === false) {
        setError(res.error ?? t("call.quickNoteError"));
        return;
      }
      // Kept open and emptied: a teacher who has one thing to jot usually has
      // a second one a minute later, and closing is one tap.
      setSummary("");
      setSkill("");
      setSaved(true);
      inputRef.current?.focus();
    } catch {
      setError(t("call.quickNoteError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-over-overlay flex items-end justify-center lg:items-center">
      {/* The backdrop is a pointer convenience only: Escape and the Close
          button below are the keyboard routes out. */}
      <div role="presentation" className="absolute inset-0 bg-scrim-2" onClick={onClose} />
      <div
        role="dialog"
        aria-label={t("call.quickNote")}
        data-testid="call-quick-note-sheet"
        className="relative m-4 max-h-over-stage w-full max-w-md overflow-y-auto rounded-2xl bg-background p-4 text-foreground shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <Heading level={4} as="h2">
            {t("call.quickNote")}
          </Heading>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("call.quickNoteClose")}
          </Button>
        </div>
        <p className="mb-2 text-sm text-muted-foreground">{t("call.quickNoteHint")}</p>
        <textarea
          ref={inputRef}
          data-testid="call-quick-note-input"
          value={summary}
          rows={2}
          maxLength={500}
          placeholder={t("call.quickNotePlaceholder")}
          aria-label={t("call.quickNote")}
          onChange={(e) => {
            setSummary(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Enter saves; Shift+Enter is a newline. IME composition is left
            // alone so a candidate-confirming Enter never saves half a word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-base"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            aria-label={t("web.dashboard.classes.focusAreas.category")}
            value={category}
            onChange={(e) => setCategory(e.target.value as InsightCategory)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_LABEL_KEY[c])}
              </option>
            ))}
          </select>
          <input
            value={skill}
            maxLength={80}
            onChange={(e) => setSkill(e.target.value)}
            placeholder={t("call.quickNoteSkill")}
            aria-label={t("web.dashboard.classes.focusAreas.skill")}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            data-testid="call-quick-note-save"
            disabled={pending || summary.trim().length === 0}
            onClick={() => void save()}
          >
            {t("call.quickNoteSave")}
          </Button>
          <p
            role="status"
            className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}
          >
            {error ?? (saved ? t("call.quickNoteSaved") : "")}
          </p>
        </div>
      </div>
    </div>
  );
}
