"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  copyNotesFromLastClass,
  createLessonNote,
  deleteLessonNote,
  moveLessonNote,
  toggleLessonNoteDone,
  updateLessonNote,
  type LessonNoteState,
} from "@/app/actions/lesson-notes";
import { useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";

export type LessonNoteRow = {
  id: string;
  body: string;
  position: number;
  done: boolean;
};

// In-class live notes (docs/features/classes-lesson-content.md, D-12). Two columns
// from one author: private teacher cues + student-facing instructions. Realtime
// sync and present mode are later phases; this is the static authoring surface.
export function LessonNotesPanel({
  bookingId,
  teacherNotes,
  studentNotes,
}: {
  bookingId: string;
  teacherNotes: LessonNoteRow[];
  studentNotes: LessonNoteRow[];
}) {
  const t = useT();

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">{t("lessonNotes.title")}</CardTitle>
            <CardDescription>{t("lessonNotes.help")}</CardDescription>
          </div>
          {/* Wrap on narrow screens so the buttons never force horizontal
              overflow; stay a tidy right-aligned row from sm up. The "join
              call" entry point moved to a dedicated card at the top of the
              class detail page (it's the primary in-class action), so it's no
              longer duplicated here. */}
          <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
            <CopyFromLastClass bookingId={bookingId} t={t} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <NoteColumn
          bookingId={bookingId}
          audience="teacher"
          notes={teacherNotes}
          title={t("lessonNotes.teacher.column")}
          placeholder={t("lessonNotes.teacherPlaceholder")}
          t={t}
        />
        <NoteColumn
          bookingId={bookingId}
          audience="student"
          notes={studentNotes}
          title={t("lessonNotes.student.column")}
          placeholder={t("lessonNotes.studentPlaceholder")}
          t={t}
        />
      </CardContent>
    </Card>
  );
}

function NoteColumn({
  bookingId,
  audience,
  notes,
  title,
  placeholder,
  t,
}: {
  bookingId: string;
  audience: "teacher" | "student";
  notes: LessonNoteRow[];
  title: string;
  placeholder: string;
  t: TFunction;
}) {
  const [state, formAction, pending] = useActionState<LessonNoteState, FormData>(
    createLessonNote,
    undefined,
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>

      {notes.length > 0 ? (
        <ul className="space-y-2">
          {notes.map((n, i) => (
            <NoteRow
              key={n.id}
              note={n}
              audience={audience}
              isFirst={i === 0}
              isLast={i === notes.length - 1}
              t={t}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("lessonNotes.empty")}</p>
      )}

      <form action={formAction} className="space-y-2">
        <input type="hidden" name="bookingId" value={bookingId} />
        <input type="hidden" name="audience" value={audience} />
        <Textarea name="body" rows={2} placeholder={placeholder} maxLength={500} />
        {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? t("lessonNotes.adding") : t("lessonNotes.add")}
        </Button>
      </form>
    </div>
  );
}

function NoteRow({
  note,
  audience,
  isFirst,
  isLast,
  t,
}: {
  note: LessonNoteRow;
  audience: "teacher" | "student";
  isFirst: boolean;
  isLast: boolean;
  t: TFunction;
}) {
  // Sibling forms (never nested): one for the inline body edit, the rest for
  // single-button controls. Nested <form> is invalid HTML.
  return (
    <li className="space-y-2 rounded-md border px-3 py-2">
      <form action={updateLessonNote} className="space-y-2">
        <input type="hidden" name="noteId" value={note.id} />
        <Textarea
          name="body"
          rows={2}
          defaultValue={note.body}
          maxLength={500}
          className={note.done ? "line-through opacity-60" : undefined}
        />
        <Button type="submit" size="sm" variant="ghost">
          {t("common.save")}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-1">
        {audience === "teacher" && (
          <SubForm action={toggleLessonNoteDone} noteId={note.id}>
            <Button type="submit" size="sm" variant="ghost">
              {note.done ? t("lessonNotes.undo") : t("lessonNotes.done")}
            </Button>
          </SubForm>
        )}
        <SubForm action={moveLessonNote} noteId={note.id} extra={{ direction: "up" }}>
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={isFirst}
            aria-label={t("lessonNotes.up")}
          >
            ↑
          </Button>
        </SubForm>
        <SubForm action={moveLessonNote} noteId={note.id} extra={{ direction: "down" }}>
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={isLast}
            aria-label={t("lessonNotes.down")}
          >
            ↓
          </Button>
        </SubForm>
        <SubForm action={deleteLessonNote} noteId={note.id}>
          <Button type="submit" size="sm" variant="ghost" className="text-destructive">
            {t("lessonNotes.remove")}
          </Button>
        </SubForm>
      </div>
    </li>
  );
}

// "Copy from last class" — appends this student's previous class notes so prep
// isn't from scratch. Surfaces a one-line error (e.g. no earlier class) inline.
function CopyFromLastClass({ bookingId, t }: { bookingId: string; t: TFunction }) {
  const [state, formAction, pending] = useActionState<LessonNoteState, FormData>(
    copyNotesFromLastClass,
    undefined,
  );
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="bookingId" value={bookingId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending
          ? t("web.dashboard.classes.lessonNotes.copying")
          : t("web.dashboard.classes.lessonNotes.copyFromLastClass")}
      </Button>
      {state?.error && <span className="ml-2 text-xs text-muted-foreground">{state.error}</span>}
    </form>
  );
}

// A standalone form so a control's submit doesn't carry the edit textarea.
function SubForm({
  action,
  noteId,
  extra,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  noteId: string;
  extra?: Record<string, string>;
  children: React.ReactNode;
}) {
  return (
    <form action={action} className="inline">
      <input type="hidden" name="noteId" value={noteId} />
      {extra &&
        Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
    </form>
  );
}
