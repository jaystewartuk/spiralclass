import "server-only";
import type { Booking, Prisma, Student, Teacher } from "@prisma/client";
import {
  recognitionLocale,
  resolveCaptionDirection,
  type CaptionDirection,
  type CaptionSession,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { cloudCaptionsConfigured } from "@/lib/captions/config";
import { captionsConsentOk } from "@/lib/captions/consent";

// Class-booking caption language/consent resolution. Captions run in the
// participants' browsers (D-185), and every fact a browser needs to caption a
// class — both directions' languages, the recognition locale, whether the
// student has consented — is resolved here, server-side, for a caller who is
// proven to be one of the booking's two participants. The client never
// chooses a language: /api/captions/translate re-resolves the direction from
// the booking on every call.
type BookingWithLanguages = Booking & {
  teacher: Pick<Teacher, "id" | "teachingLanguage" | "country">;
  student: Pick<Student, "nativeLanguage">;
};

function findBookingWithLanguages(
  where: Prisma.BookingWhereInput,
): Promise<BookingWithLanguages | null> {
  return prisma.booking.findFirst({
    where,
    include: {
      teacher: { select: { id: true, teachingLanguage: true, country: true } },
      student: { select: { nativeLanguage: true } },
    },
  }) as Promise<BookingWithLanguages | null>;
}

// The caption direction for a role on a booking: a booking-level override, if
// the teacher set one for this class, else the teacher/student's own default
// language. Live-read every call — the override is NOT snapshotted, so a
// mid-day language change takes effect on the next caption config poll (see
// the schema comment on Booking.teacherLanguageOverride).
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

// Whether a participant's speech may be captioned at all — whichever browser
// would recognise it (D-22, D-185). Only the student side is gated — a teacher's
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

// Who is asking, proven by the route's session gate: the teacher by her own
// id, a student by every row her sign-in owns (studentIdentityIds — one
// person studying with two teachers has a row per teacher, and the booking
// may sit on any of them).
export type CaptionCaller =
  { role: "teacher"; teacherId: string } | { role: "student"; studentIds: string[] };

export async function resolveCaptionSession(
  bookingId: string,
  caller: CaptionCaller,
): Promise<CaptionSession | null> {
  // Scoped to the caller: a booking she is not a party to resolves to null,
  // exactly like one that does not exist.
  const booking = await findBookingWithLanguages(
    caller.role === "teacher"
      ? { id: bookingId, teacherId: caller.teacherId }
      : { id: bookingId, studentId: { in: caller.studentIds } },
  );
  if (!booking) return null;
  const teacherDirection = directionForBooking(booking, "teacher");
  const studentDirection = directionForBooking(booking, "student");
  return {
    bookingId: booking.id,
    role: caller.role,
    teacherIdentity: booking.teacherId,
    directions: { teacher: teacherDirection, student: studentDirection },
    recognitionLocales: {
      teacher: recognitionLocale(teacherDirection.source, booking.teacher.country),
      student: recognitionLocale(studentDirection.source),
    },
    studentConsent: await captionsPublishConsentOk(booking, "student"),
    cloudRecognition: cloudCaptionsConfigured(),
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
