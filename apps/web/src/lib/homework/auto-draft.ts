import "server-only";

import { createT, hasHomeworkCallout, parseMaterialDoc, type AppLocale } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { enqueueHomeworkAssigned } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { logger } from "@/lib/logger";

const log = logger({ surface: "homework-auto-draft" });

// Auto-drafts a real, submittable Assignment the moment a teacher's saved
// class content contains a [!homework]/[!exercise] callout — closing the gap
// where that callout was otherwise just styled prose with no connection to
// the structured homework feature (docs/features/homework.md).
// Called from the ONE shared saveClassContentForBooking handler, so both web
// and mobile get this for free — no per-platform wiring needed.
//
// Fires AT MOST ONCE per material: a material that already has an Assignment
// referencing it (via sourceMaterialId) is left alone on every later save, so
// editing a class's content never spawns a second assignment. The auto-draft
// is immediately visible to the student (matches today's manual-create
// behavior) and stays fully teacher-editable/deletable via the existing
// Homework panel — nothing here is a one-way door.
//
// Best-effort: never throws. A failure here must never fail the content save
// it's piggybacking on.
export async function maybeAutoDraftAssignmentFromMaterial(input: {
  teacherId: string;
  materialId: string;
  bookingId: string;
  studentId: string;
  body: string;
  locale: AppLocale;
}): Promise<void> {
  try {
    if (!hasHomeworkCallout(parseMaterialDoc(input.body))) return;

    const already = await prisma.assignment.findFirst({
      where: { sourceMaterialId: input.materialId },
      select: { id: true },
    });
    if (already) return;

    // Default due date = the student's next scheduled class with this
    // teacher, if any — matches "do this before our next class" rather than a
    // fixed offset that ignores the actual schedule.
    const nextClass = await prisma.booking.findFirst({
      where: {
        teacherId: input.teacherId,
        studentId: input.studentId,
        status: "scheduled",
        scheduledStart: { gt: new Date() },
      },
      orderBy: { scheduledStart: "asc" },
      select: { scheduledStart: true },
    });

    const t = createT(input.locale);
    const created = await prisma.assignment.create({
      data: {
        bookingId: input.bookingId,
        teacherId: input.teacherId,
        title: t("homework.teacher.title"),
        dueAt: nextClass?.scheduledStart ?? null,
        sourceMaterialId: input.materialId,
      },
    });

    trackServerEvent({
      name: "homework_assignment_created",
      distinctId: input.teacherId,
      properties: {
        teacherId: input.teacherId,
        bookingId: input.bookingId,
        assignmentId: created.id,
        hasDueDate: created.dueAt != null,
        surface: "auto_draft",
      },
    });

    const notificationId = await enqueueHomeworkAssigned(prisma, {
      studentId: input.studentId,
      teacherId: input.teacherId,
      bookingId: input.bookingId,
      assignmentTitle: created.title,
    });
    try {
      await emitNotificationQueued({ notificationId, teacherId: input.teacherId });
    } catch (err) {
      log.warn("emit failed", { error: err });
    }
  } catch (err) {
    log.error("auto-draft failed", err, { materialId: input.materialId });
  }
}
