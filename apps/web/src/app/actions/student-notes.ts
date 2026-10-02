"use server";

import { issueMessage } from "@spiralclass/shared";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

// Teacher-private notes about a student. Scoped to (teacher, student) and never
// shown to the student. Deliberately NOT routed through the Override audit
// table: those rows surface in the student's class history, which would leak the
// notes' contents. The note rows' own created_at/updated_at are the only trail.
// Analytics carry counts/ids only — never the note body.

export type StudentNoteState = { error?: string; ok?: string } | undefined;

const studentIdField = z.string().uuid();
const noteIdField = z.string().uuid();
const bodyField = z.string().trim().min(1, "web.action.studentNotes.empty").max(5000);

async function ownsStudent(teacherId: string, studentId: string): Promise<boolean> {
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } },
    select: { teacherId: true },
  });
  return link != null;
}

// ---------- add ----------

const addSchema = z.object({ studentId: studentIdField, body: bodyField });

export async function addStudentNote(
  _prev: StudentNoteState,
  formData: FormData,
): Promise<StudentNoteState> {
  const t = createT(await getPreferredLocale());
  const parsed = addSchema.safeParse({
    studentId: formData.get("studentId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const teacher = await requireOnboardedTeacher();
  if (!(await ownsStudent(teacher.id, parsed.data.studentId))) {
    return { error: t("web.action.studentNotInList") };
  }

  await prisma.studentNote.create({
    data: {
      teacherId: teacher.id,
      studentId: parsed.data.studentId,
      body: parsed.data.body,
    },
  });

  trackServerEvent({
    name: "student_note_added",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, studentId: parsed.data.studentId },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${parsed.data.studentId}`);
  return { ok: t("web.action.studentNotes.added") };
}

// ---------- update ----------

const updateSchema = z.object({ noteId: noteIdField, body: bodyField });

export async function updateStudentNote(
  _prev: StudentNoteState,
  formData: FormData,
): Promise<StudentNoteState> {
  const t = createT(await getPreferredLocale());
  const parsed = updateSchema.safeParse({
    noteId: formData.get("noteId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const teacher = await requireOnboardedTeacher();
  // Scope the write by teacher_id so a teacher can only edit their own notes.
  const updated = await prisma.studentNote.updateMany({
    where: { id: parsed.data.noteId, teacherId: teacher.id },
    data: { body: parsed.data.body },
  });
  if (updated.count === 0) {
    return { error: t("web.action.studentNotes.notFound") };
  }

  const note = await prisma.studentNote.findUnique({
    where: { id: parsed.data.noteId },
    select: { studentId: true },
  });

  if (note) {
    trackServerEvent({
      name: "student_note_updated",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, studentId: note.studentId },
    });
    await flushAnalytics();
    revalidateAfterAction(`/dashboard/students/${note.studentId}`);
  }
  return { ok: t("web.action.studentNotes.updated") };
}

// ---------- delete ----------

const deleteSchema = z.object({ noteId: noteIdField });

export async function deleteStudentNote(
  _prev: StudentNoteState,
  formData: FormData,
): Promise<StudentNoteState> {
  const t = createT(await getPreferredLocale());
  const parsed = deleteSchema.safeParse({ noteId: formData.get("noteId") });
  if (!parsed.success) {
    return { error: t("web.action.invalidData") };
  }

  const teacher = await requireOnboardedTeacher();
  // Read the studentId (for revalidation) and authorize in one ownership-scoped
  // lookup before deleting.
  const note = await prisma.studentNote.findFirst({
    where: { id: parsed.data.noteId, teacherId: teacher.id },
    select: { studentId: true },
  });
  if (!note) {
    return { error: t("web.action.studentNotes.notFound") };
  }

  await prisma.studentNote.delete({ where: { id: parsed.data.noteId } });

  trackServerEvent({
    name: "student_note_deleted",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, studentId: note.studentId },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${note.studentId}`);
  return { ok: t("web.action.studentNotes.deleted") };
}
