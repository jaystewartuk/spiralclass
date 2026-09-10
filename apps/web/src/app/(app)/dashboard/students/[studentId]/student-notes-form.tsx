"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addStudentNote,
  updateStudentNote,
  deleteStudentNote,
  type StudentNoteState,
} from "@/app/actions/student-notes";
import { useT } from "@/components/locale-provider";

export type StudentNoteView = {
  id: string;
  body: string;
  timestampLabel: string;
  edited: boolean;
};

// Teacher-private notes. Renders an "add" box plus an editable, newest-first
// list. Each item owns its own action state so editing/deleting one note never
// disturbs the others.
export function StudentNotes({
  studentId,
  notes,
}: {
  studentId: string;
  notes: StudentNoteView[];
}) {
  const t = useT();

  return (
    <div className="space-y-4">
      <AddStudentNoteForm studentId={studentId} />
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("web.studentNotes.empty")}</p>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <StudentNoteItem key={note.id} note={note} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddStudentNoteForm({ studentId }: { studentId: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState<StudentNoteState, FormData>(
    addStudentNote,
    undefined,
  );

  return (
    <form
      action={formAction}
      className="space-y-2"
      // Clear the box after a successful add (the server returns `ok`).
      key={state?.ok ? "added" : "draft"}
    >
      <input type="hidden" name="studentId" value={studentId} />
      <Label htmlFor="newStudentNote" className="sr-only">
        {t("web.studentNotes.newNote")}
      </Label>
      <Textarea
        id="newStudentNote"
        name="body"
        required
        minLength={1}
        maxLength={5000}
        rows={3}
        placeholder={t("web.studentNotes.placeholder")}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("web.studentNotes.saving") : t("web.studentNotes.add")}
        </Button>
        {state?.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        {state?.ok && (
          <p role="status" className="text-sm text-success">
            {state.ok}
          </p>
        )}
      </div>
    </form>
  );
}

function StudentNoteItem({ note }: { note: StudentNoteView }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState<StudentNoteState, FormData>(
    updateStudentNote,
    undefined,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<StudentNoteState, FormData>(
    deleteStudentNote,
    undefined,
  );

  if (editing) {
    return (
      <form action={editAction} className="space-y-2 rounded-md border px-3 py-2">
        <input type="hidden" name="noteId" value={note.id} />
        <Textarea
          name="body"
          required
          minLength={1}
          maxLength={5000}
          rows={3}
          defaultValue={note.body}
          aria-label={t("web.studentNotes.editNote")}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={editPending}>
            {editPending ? t("web.studentNotes.saving") : t("common.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={editPending}
          >
            {t("common.cancel")}
          </Button>
          {editState?.error && (
            <p role="alert" className="text-sm text-destructive">
              {editState.error}
            </p>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <p className="break-words whitespace-pre-wrap">{note.body}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {note.timestampLabel}
          {note.edited && t("web.studentNotes.editedSuffix")}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </Button>
          <form action={deleteAction}>
            <input type="hidden" name="noteId" value={note.id} />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={deletePending}
            >
              {t("common.delete")}
            </Button>
          </form>
        </span>
      </div>
      {deleteState?.error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {deleteState.error}
        </p>
      )}
    </div>
  );
}
