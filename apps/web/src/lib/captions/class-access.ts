import "server-only";
import type { Booking, Prisma, Student, Teacher } from "@prisma/client";
import { resolveCaptionDirection, type CaptionDirection } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { captionsConsentOk } from "@/lib/captions/consent";

// Class-booking caption language/consent resolution. Ordinary scheduled
// classes are captioned server-side by the LiveKit Agent
// (packages/livekit-captions-agent, docs/architecture/
// the captions access review) — the per-viewer resolvers this file used to
// export for the (now-deleted) client-driven token/translate routes are
// gone; resolveClassCallRoomConfig below is the Agent's equivalent, needing
// BOTH directions at once rather than a single session-scoped viewer.
type BookingWithLanguages = Booking & {
  teacher: Pick<Teacher, "id" | "teachingLanguage">;
  student: Pick<Student, "nativeLanguage">;
};

function findBookingWithLanguages(
  where: Prisma.BookingWhereInput,
): Promise<BookingWithLanguages | null> {
  return prisma.booking.findFirst({
    where,
    include: {
      teacher: { select: { id: true, teachingLanguage: true } },
      student: { select: { nativeLanguage: true } },
    },
  }) as Promise<BookingWithLanguages | null>;
}

// The caption direction for a role on a booking: a booking-level override, if
// the teacher set one for this class, else the teacher/student's own default
// language. Live-read every call — the override is NOT snapshotted, so a
// mid-day language change takes effect on the caller's next join (see the
// schema comment on Booking.teacherLanguageOverride).
function directionForBooking(
  booking: BookingWithLanguages,
  role: "teacher" | "student",
): CaptionDirection {
  return resolveCaptionDirection({
    role,
    teacherLanguage: booking.teacherLanguageOverride ?? booking.teacher.teachingLanguage,
    studentLanguage: booking.studentLanguageOverride ?? booking.student.nativeLanguage,
  });
}

// Whether THIS viewer's own mic may be published to ASR (docs/architecture/
// LIVEKIT_CAPTIONS_AUDIT.md P0). Only the student side is gated — a teacher's
// own audio has no per-student consent record to check (covered instead by
// the Terms of Service + the in-call disclosure). Missing TeacherStudent row
// (shouldn't happen for a resolved booking, but fail closed if it does) reads
// as "no consent" rather than throwing.
export async function captionsPublishConsentOk(
  booking: Pick<Booking, "teacherId" | "studentId">,
  role: "teacher" | "student",
): Promise<boolean> {
  if (role === "teacher") return true;
  const pairing = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: booking.teacherId, studentId: booking.studentId } },
    select: { isMinor: true, captionsConsentAt: true, captionsGuardianConsentAt: true },
  });
  if (!pairing) return false;
  return captionsConsentOk(pairing);
}

// Room-config resolution for the server-side captions Agent
// (packages/livekit-captions-agent, docs/architecture/
// the captions access review): there's no single "viewer" here — the Agent
// needs BOTH directions (it transcribes and translates both parties) plus
// the student consent check, all in one call, keyed only by bookingId (which
// it recovers from the LiveKit room name via bookingIdFromCallRoom). Reuses
// the same findBookingWithLanguages/directionForBooking/
// captionsPublishConsentOk this file already has.
export type ClassCallRoomConfig = {
  bookingId: string;
  teacherId: string;
  studentId: string;
  teacherDirection: CaptionDirection;
  studentDirection: CaptionDirection;
  studentCaptionsAllowed: boolean;
};

export async function resolveClassCallRoomConfig(
  bookingId: string,
): Promise<ClassCallRoomConfig | null> {
  const booking = await findBookingWithLanguages({ id: bookingId });
  if (!booking) return null;
  const studentCaptionsAllowed = await captionsPublishConsentOk(booking, "student");
  return {
    bookingId: booking.id,
    teacherId: booking.teacherId,
    studentId: booking.studentId,
    teacherDirection: directionForBooking(booking, "teacher"),
    studentDirection: directionForBooking(booking, "student"),
    studentCaptionsAllowed,
  };
}

// Sets (or clears, with null) the per-booking language override — called by
// the web server action (updateBookingLanguageOverrideAction). The transaction
// + audit-write shape lives in exactly one place. Caller has
// already validated the language codes and reason string; this only checks
// booking ownership.
export async function applyBookingLanguageOverride(input: {
  teacherId: string;
  bookingId: string;
  teacherLanguage: string | null;
  studentLanguage: string | null;
  reason: string;
}): Promise<{ ok: true } | { ok: false; reason: "not-found" }> {
  const booking = await prisma.booking.findFirst({
    where: { id: input.bookingId, teacherId: input.teacherId },
    select: { id: true, teacherLanguageOverride: true, studentLanguageOverride: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        teacherLanguageOverride: input.teacherLanguage,
        studentLanguageOverride: input.studentLanguage,
      },
    });
    await tx.override.create({
      data: {
        teacherId: input.teacherId,
        targetType: "booking",
        targetId: booking.id,
        action: "set_class_language",
        reason: input.reason,
        beforeJson: {
          teacherLanguageOverride: booking.teacherLanguageOverride,
          studentLanguageOverride: booking.studentLanguageOverride,
        },
        afterJson: {
          teacherLanguageOverride: input.teacherLanguage,
          studentLanguageOverride: input.studentLanguage,
        },
      },
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      action: "set_class_language",
      targetType: "booking",
      targetId: booking.id,
    },
  });
  await flushAnalytics();

  return { ok: true };
}
