"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { inngest } from "@/lib/inngest/client";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { maybeEmitFirstBooking } from "@/lib/analytics/first-events";
import { bookPackageSlot, type BookingEventEmitter } from "@/lib/booking/book-package-slot";
import type { TeacherBookingError } from "@/lib/booking/teacher-booking-errors";
import { revalidateAfterAction } from "@/lib/revalidate";
import { usesEnglishCopy } from "@spiralclass/shared";

// Item 10 — teacher self-serve booking. Teachers take bookings over WhatsApp
// constantly; this lets a teacher put a class on her own calendar against one
// of a student's active packages, booked exactly as if the student had done it.
//
// Tenancy: everything is scoped by teacherId from requireOnboardedTeacher.
// The package is looked up by id + teacherId, and the booking is created against
// the package's own studentId row (multi-teacher identity — see studentIdentityIds
// in the student flow; on the teacher side the package row already names her
// tenant's student row, so no inbox expansion is needed or wanted).
//
// The teacher bypasses her own minAdvanceH (she's confirming something already
// agreed) but NOT availability windows, blocked dates or slot collisions — that
// rule split lives in bookPackageSlot. She does not get the booking_created_teacher
// notification (she made the booking); the student gets the normal confirmation.

/**
 * A CODE, not a sentence.
 *
 * This used to be the finished string, picked by `locale === "en" ? … : …`,
 * which quietly made Spanish the message for every locale that is not English —
 * including the French one this platform ships. The wording lives in the
 * catalog and is resolved by the component that renders it; see
 * `@/lib/booking/teacher-booking-errors`.
 */
export type TeacherBookingState = { error?: TeacherBookingError; ok?: string } | undefined;

const teacherBookingSchema = z.object({
  packageId: z.string().uuid(),
  startUtc: z.string().datetime(),
});

const emitViaInngest: BookingEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

export async function createTeacherBooking(
  _prev: TeacherBookingState,
  formData: FormData,
): Promise<TeacherBookingState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = teacherBookingSchema.safeParse({
    packageId: formData.get("packageId"),
    startUtc: formData.get("startUtc"),
  });
  if (!parsed.success) return { error: "invalid" };

  const teacher = await requireOnboardedTeacher();

  // Tenant isolation: scope the package to the authenticated teacher. The booking is
  // created against the package's own studentId.
  const pkg = await prisma.package.findFirst({
    where: { id: parsed.data.packageId, teacherId: teacher.id, status: "active" },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      classesUsed: true,
      classesTotal: true,
      classDurationMin: true,
      expiresAt: true,
      templateId: true,
      template: { select: { name: true, singleClass: true } },
    },
  });
  if (!pkg) return { error: "package-not-found" };

  const outcome = await bookPackageSlot(
    { prisma, emit: emitViaInngest },
    {
      pkg,
      teacher: {
        timezone: teacher.timezone,
        bufferMin: teacher.bufferMin,
        minAdvanceH: teacher.minAdvanceH,
        maxAdvanceDays: teacher.maxAdvanceDays,
      },
      startUtc: new Date(parsed.data.startUtc),
      // She's confirming an already-agreed class — skip her own lead-time rule.
      bypassMinAdvance: true,
      // She booked it herself; no booking_created_teacher notification.
      notifyTeacher: false,
      // Record the intervention like other teacher actions (teacher overrides audit trail).
      override: {
        action: "teacher_book_class",
        reason: en
          ? "Class booked by the teacher on the student's behalf."
          : "Clase reservada por la profe a nombre del alumno.",
      },
    },
  );

  if (outcome.code !== "ok") {
    // The codes bookPackageSlot already speaks, passed through as codes. The
    // default is deliberately the widest wording: an outcome this switch does
    // not name is one where the slot could not be taken, whatever the reason.
    switch (outcome.code) {
      case "package-exhausted":
      case "package-expired":
      case "slot-taken":
        return { error: outcome.code };
      default:
        return { error: "slot-unavailable" };
    }
  }

  trackServerEvent({
    name: "booking_created",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      bookingId: outcome.bookingId,
      packageId: pkg.id,
      via: "direct",
      source: "teacher",
      studentId: pkg.studentId,
      teacherName: teacher.name,
      className: pkg.template?.name ?? null,
      classType: pkg.template?.singleClass ? "single_class" : "package",
      classId: pkg.templateId,
      scheduledAt: parsed.data.startUtc,
    },
  });
  await maybeEmitFirstBooking(teacher.id, outcome.bookingId);
  await flushAnalytics();

  revalidateAfterAction("/dashboard/classes");
  redirect(`/dashboard/classes/${outcome.bookingId}`);
}
