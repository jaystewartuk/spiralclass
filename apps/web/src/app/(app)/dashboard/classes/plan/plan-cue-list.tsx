"use client";

import { useActionState, useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  createLessonNote,
  deleteLessonNote,
  moveLessonNote,
  toggleLessonNoteDone,
  updateLessonNote,
  type LessonNoteState,
} from "@/app/actions/lesson-notes";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import type { LessonNoteRow } from "../[bookingId]/lesson-notes-panel";

/** Every note action on this page says so, so it refreshes this page (actions/lesson-notes.ts). */
function planForm(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  data.set("from", "plan");
  return data;
}

/**
 * One class's bullets, read like a notebook page: a checkbox and a line of
 * text each, nothing else. The class page's editor gives every note its own
 * text box, save button and control row, which is right for working on one
 * class and far too heavy for reading a whole day. Here a line turns into an
 * editor only when it is tapped, and only that line.
 *
 * Same rows and the same actions as the class page's private-cue column.
 */
export function PlanCueList({
  bookingId,
  studentName,
  cues,
}: {
  bookingId: string;
  studentName: string;
  cues: LessonNoteRow[];
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Ticking a line is the thing she does most, often mid-class, so it answers
  // at once instead of after the round trip.
  const [shown, toggleShown] = useOptimistic(cues, (state, id: string) =>
    state.map((c) => (c.id === id ? { ...c, done: !c.done } : c)),
  );
  const [addState, addAction, adding] = useActionState<LessonNoteState, FormData>(
    createLessonNote,
    undefined,
  );

  const toggle = (id: string) =>
    startTransition(async () => {
      toggleShown(id);
      await toggleLessonNoteDone(planForm({ noteId: id }));
    });

  return (
    <div className="space-y-2">
      {shown.length > 0 && (
        <ul className="space-y-1">
          {shown.map((cue, i) =>
            editing === cue.id ? (
              <EditRow
                key={cue.id}
                cue={cue}
                isFirst={i === 0}
                isLast={i === shown.length - 1}
                onDone={() => setEditing(null)}
              />
            ) : (
              <li key={cue.id} className="flex items-start gap-3 py-1">
                <Checkbox
                  checked={cue.done}
                  onCheckedChange={() => toggle(cue.id)}
                  aria-label={t("web.dashboard.classes.plan.markDone", { cue: cue.body })}
                  className="mt-0.5"
                />
                {/* The line itself is the edit affordance: a text-weight
                    button, left-aligned and wrapping like the words it is. */}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setEditing(cue.id)}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-start px-0 py-0 text-left font-normal break-words whitespace-normal hover:bg-transparent hover:underline",
                    cue.done && "text-muted-foreground line-through",
                  )}
                >
                  {cue.body}
                  <span className="sr-only"> — {t("web.dashboard.classes.plan.editHint")}</span>
                </Button>
              </li>
            ),
          )}
        </ul>
      )}

      <form action={addAction} className="flex gap-2">
        <input type="hidden" name="bookingId" value={bookingId} />
        <input type="hidden" name="audience" value="teacher" />
        <input type="hidden" name="from" value="plan" />
        <Input
          name="body"
          maxLength={500}
          placeholder={t("web.dashboard.classes.plan.placeholder")}
          aria-label={t("web.dashboard.classes.plan.addLabel", { name: studentName })}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={adding} className="shrink-0">
          {adding ? t("lessonNotes.adding") : t("lessonNotes.add")}
        </Button>
      </form>
      {addState?.error && <p className="text-sm text-destructive">{addState.error}</p>}
    </div>
  );
}

/** The one line being edited: its text, save/cancel, and the rarer moves. */
function EditRow({
  cue,
  isFirst,
  isLast,
  onDone,
}: {
  cue: LessonNoteRow;
  isFirst: boolean;
  isLast: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const run = (action: (data: FormData) => Promise<void>, extra: Record<string, string> = {}) =>
    startTransition(async () => {
      await action(planForm({ noteId: cue.id, ...extra }));
      onDone();
    });

  return (
    <li className="space-y-2 rounded-md border p-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const body = String(new FormData(e.currentTarget).get("body") ?? "");
          run(updateLessonNote, { body });
        }}
      >
        <Input
          name="body"
          defaultValue={cue.body}
          maxLength={500}
          autoFocus
          aria-label={t("web.dashboard.classes.plan.editLabel")}
          onKeyDown={(e) => {
            if (e.key === "Escape") onDone();
          }}
        />
        <Button type="submit" size="sm" disabled={pending} className="shrink-0">
          {t("common.save")}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || isFirst}
          onClick={() => run(moveLessonNote, { direction: "up" })}
          aria-label={t("lessonNotes.up")}
        >
          ↑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || isLast}
          onClick={() => run(moveLessonNote, { direction: "down" })}
          aria-label={t("lessonNotes.down")}
        >
          ↓
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(deleteLessonNote)}
          className="text-destructive"
        >
          {t("lessonNotes.remove")}
        </Button>
      </div>
    </li>
  );
}
