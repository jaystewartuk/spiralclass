"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { generateSummaryText, SummaryUnavailableError } from "@/lib/lesson-notes/summary";
import { createBookmark } from "@/lib/lesson-notes/bookmarks";
import { formatZonedDateTime } from "@/lib/date-display";
import { logger } from "@/lib/logger";

const log = logger({ surface: "lesson-notes" });

// In-class live notes (docs/features/classes-lesson-content.md, D-15).
//
// Authoring is intentionally NOT a Pro feature (D-15): every teacher can write
// cues and instructions. The Pro gate lands later on the live surfaces (present
// mode, the realtime student panel), not here. Each action is tenant-scoped via
// requireOnboardedTeacher() + a booking ownership check, mirroring the class
// materials actions.

const audienceSchema = z.enum(["teacher", "student"]);
const MAX_BODY = 500;

export type LessonNoteState = { error?: string; ok?: boolean } | undefined;

// Confirm the booking belongs to the signed-in teacher (tenant isolation). Returns the
// booking id or null.
async function ownedBookingId(bookingId: string, teacherId: string): Promise<string | null> {
  if (!bookingId) return null;
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId },
    select: { id: true },
  });
  return booking?.id ?? null;
}

// Pull the notes from this student's previous class into the current one, so a
// teacher who runs the same arc each week doesn't start from a blank panel
// (live-notes-panel.md). Copies BOTH audience columns from the most recent
// earlier booking for the same student that actually has notes, appending after
// anything already here and resetting the `done` state (a fresh class hasn't
// covered them yet). Never overwrites or dedupes — the teacher can trim.
export async function copyNotesFromLastClass(
  _prev: LessonNoteState,
  formData: FormData,
): Promise<LessonNoteState> {
  const teacher = await requireOnboardedTeacher();
  const en = (await getPreferredLocale()) === "en";

  const bookingId = String(formData.get("bookingId") ?? "");
  const current = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: { id: true, studentId: true, scheduledStart: true },
  });
  if (!current) return { error: en ? "Class not found." : "Clase no encontrada." };

  // The most recent earlier class for this student that has any (non-bookmark)
  // notes — a bookmark is a call-instance-specific marker, not a reusable cue.
  const source = await prisma.booking.findFirst({
    where: {
      teacherId: teacher.id,
      studentId: current.studentId,
      id: { not: current.id },
      scheduledStart: { lt: current.scheduledStart },
      lessonNotes: { some: { kind: "text" } },
    },
    orderBy: { scheduledStart: "desc" },
    select: {
      lessonNotes: {
        where: { kind: "text" },
        select: { audience: true, body: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!source || source.lessonNotes.length === 0) {
    return {
      error: en
        ? "No earlier class with notes to copy from."
        : "No hay una clase anterior con notas para copiar.",
    };
  }

  // Append after the current end of each audience column so existing notes stay
  // put. Track the next position per audience as we go.
  const tails = await prisma.lessonNote.groupBy({
    by: ["audience"],
    where: { bookingId: current.id },
    _max: { position: true },
  });
  const nextPos: Record<string, number> = { teacher: 0, student: 0 };
  for (const t of tails) nextPos[t.audience] = (t._max.position ?? -1) + 1;

  await prisma.lessonNote.createMany({
    data: source.lessonNotes.map((n) => ({
      bookingId: current.id,
      teacherId: teacher.id,
      audience: n.audience,
      body: n.body,
      position: nextPos[n.audience]++,
    })),
  });

  revalidatePath(`/dashboard/classes/${current.id}`);
  return { ok: true };
}

// In-call bookmark (D-97) — a one-tap "mark this moment" during the live
// call. Plain callable action (bookingId) => result, called from the
// call-page button, not a <form> — mirrors app/actions/call-nudge.ts.
export async function createLessonBookmark(
  bookingId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const teacher = await requireOnboardedTeacher();
  const en = (await getPreferredLocale()) === "en";
  const label = en ? "Bookmark" : "Marcador";
  const result = await createBookmark(prisma, { bookingId, teacherId: teacher.id, label });
  if (result.ok) revalidatePath(`/dashboard/classes/${bookingId}/replay`);
  return result;
}

export async function createLessonNote(
  _prev: LessonNoteState,
  formData: FormData,
): Promise<LessonNoteState> {
  const teacher = await requireOnboardedTeacher();
  const en = (await getPreferredLocale()) === "en";

  const bookingId = String(formData.get("bookingId") ?? "");
  const body = String(formData.get("body") ?? "")
    .trim()
    .slice(0, MAX_BODY);
  const audience = audienceSchema.safeParse(String(formData.get("audience") ?? ""));

  if (!audience.success) {
    return { error: en ? "Pick who the note is for." : "Elige para quién es la nota." };
  }
  if (!body) {
    return { error: en ? "Write something first." : "Escribe algo primero." };
  }
  const ownedId = await ownedBookingId(bookingId, teacher.id);
  if (!ownedId) return { error: en ? "Class not found." : "Clase no encontrada." };

  // Append to the end of its own audience column.
  const last = await prisma.lessonNote.findFirst({
    where: { bookingId: ownedId, audience: audience.data },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  await prisma.lessonNote.create({
    data: {
      bookingId: ownedId,
      teacherId: teacher.id,
      audience: audience.data,
      body,
      position: (last?.position ?? -1) + 1,
    },
    select: { id: true },
  });

  trackServerEvent({
    name: "lesson_note_created",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, bookingId: ownedId, audience: audience.data },
  });
  await flushAnalytics();

  revalidatePath(`/dashboard/classes/${ownedId}`);
  return { ok: true };
}

// Inline body edit. Plain form action (no surfaced state): an empty body is a
// no-op rather than an error, so the row simply keeps its previous text.
export async function updateLessonNote(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const noteId = String(formData.get("noteId") ?? "");
  const body = String(formData.get("body") ?? "")
    .trim()
    .slice(0, MAX_BODY);
  if (!noteId || !body) return;

  // Tenant scope through the relation — the note is reachable only if its
  // booking belongs to this teacher.
  const note = await prisma.lessonNote.findFirst({
    where: { id: noteId, booking: { teacherId: teacher.id } },
    select: { id: true, bookingId: true },
  });
  if (!note) return;

  await prisma.lessonNote.update({ where: { id: note.id }, data: { body } });
  revalidatePath(`/dashboard/classes/${note.bookingId}`);
}

export async function deleteLessonNote(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const noteId = String(formData.get("noteId") ?? "");
  if (!noteId) return;

  const note = await prisma.lessonNote.findFirst({
    where: { id: noteId, booking: { teacherId: teacher.id } },
    select: { id: true, bookingId: true },
  });
  if (!note) return;

  await prisma.lessonNote.delete({ where: { id: note.id } });
  revalidatePath(`/dashboard/classes/${note.bookingId}`);
}

// Teacher checks a cue off (or back on) mid-class. Student-audience notes have
// no "done" state, so toggling one is a no-op.
export async function toggleLessonNoteDone(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const noteId = String(formData.get("noteId") ?? "");
  if (!noteId) return;

  const note = await prisma.lessonNote.findFirst({
    where: { id: noteId, audience: "teacher", booking: { teacherId: teacher.id } },
    select: { id: true, bookingId: true, doneAt: true },
  });
  if (!note) return;

  await prisma.lessonNote.update({
    where: { id: note.id },
    data: { doneAt: note.doneAt ? null : new Date() },
  });
  revalidatePath(`/dashboard/classes/${note.bookingId}`);
}

// Swap a note with its neighbour in the same audience column. Simple position
// swap — full drag-reorder is deferred (live-notes-panel.md phase notes).
export async function moveLessonNote(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const noteId = String(formData.get("noteId") ?? "");
  const direction = String(formData.get("direction") ?? "");
  if (!noteId || (direction !== "up" && direction !== "down")) return;

  const note = await prisma.lessonNote.findFirst({
    where: { id: noteId, booking: { teacherId: teacher.id } },
    select: { id: true, bookingId: true, audience: true, position: true },
  });
  if (!note) return;

  const neighbour = await prisma.lessonNote.findFirst({
    where: {
      bookingId: note.bookingId,
      audience: note.audience,
      position: direction === "up" ? { lt: note.position } : { gt: note.position },
    },
    orderBy: { position: direction === "up" ? "desc" : "asc" },
    select: { id: true, position: true },
  });
  if (!neighbour) return; // already at an edge

  // Plain swap — position has no unique constraint, so no temp value needed.
  await prisma.$transaction([
    prisma.lessonNote.update({ where: { id: note.id }, data: { position: neighbour.position } }),
    prisma.lessonNote.update({ where: { id: neighbour.id }, data: { position: note.position } }),
  ]);
  revalidatePath(`/dashboard/classes/${note.bookingId}`);
}

// AI post-class summary (live-notes-panel.md "step 2", D-15). Generates a short
// teacher-private recap from the class's live notes via Claude and stores it
// (one per booking; regenerating overwrites). This is a Pro live-notes surface,
// so it's gated like present mode; authoring stays free. Only offered once the
// class has started — there's nothing to recap before it happens.
export async function generateLessonSummary(
  _prev: LessonNoteState,
  formData: FormData,
): Promise<LessonNoteState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "lesson_notes");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const bookingId = String(formData.get("bookingId") ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: {
      id: true,
      scheduledStart: true,
      student: { select: { name: true } },
      // Bookmarks aren't cues/content — exclude them from the AI summary source.
      lessonNotes: {
        where: { kind: "text" },
        select: { audience: true, body: true, position: true, doneAt: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!booking) return { error: en ? "Class not found." : "Clase no encontrada." };

  if (booking.scheduledStart > new Date()) {
    return {
      error: en
        ? "You can summarize the class once it has started."
        : "Puedes resumir la clase una vez que haya comenzado.",
    };
  }

  const teacherCues = booking.lessonNotes
    .filter((n) => n.audience === "teacher")
    .map((n) => ({ body: n.body, done: n.doneAt != null }));
  const studentNotes = booking.lessonNotes
    .filter((n) => n.audience === "student")
    .map((n) => ({ body: n.body }));

  if (teacherCues.length === 0 && studentNotes.length === 0) {
    return {
      error: en
        ? "Add some notes to the class first — there's nothing to summarize yet."
        : "Agrega algunas notas a la clase primero; aún no hay nada que resumir.",
    };
  }

  let result: { body: string; model: string };
  try {
    result = await generateSummaryText({
      studentName: booking.student.name,
      when: formatZonedDateTime(booking.scheduledStart, teacher.timezone, locale),
      teacherCues,
      studentNotes,
      en,
    });
  } catch (err) {
    if (err instanceof SummaryUnavailableError) {
      return {
        error: en
          ? "Summaries aren't available right now."
          : "Los resúmenes no están disponibles en este momento.",
      };
    }
    log.error("lesson summary generation failed", err);
    return {
      error: en
        ? "Couldn't generate the summary. Please try again."
        : "No se pudo generar el resumen. Inténtalo de nuevo.",
    };
  }

  if (!result.body) {
    return {
      error: en ? "The summary came back empty." : "El resumen llegó vacío.",
    };
  }

  await prisma.lessonSummary.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      teacherId: teacher.id,
      body: result.body,
      model: result.model,
    },
    update: { body: result.body, model: result.model },
  });

  trackServerEvent({
    name: "lesson_summary_generated",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, bookingId: booking.id },
  });
  await flushAnalytics();

  revalidatePath(`/dashboard/classes/${booking.id}`);
  return { ok: true };
}
