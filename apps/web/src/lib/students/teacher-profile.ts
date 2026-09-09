import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";

// A student's view of their teacher(s): only the fields a teacher already
// shares with the world on the public booking page (name/photo/headline/bio,
// and the WhatsApp number she deliberately published there) plus the contact
// details a student needs (email/phone/timezone/language) — nothing financial,
// nothing teacher-private. Scoped exclusively through the TeacherStudent join,
// same as messages/packages/bookings, so a student can never resolve a teacher
// they don't actually study with.
//
// The boundary is "already public OR already hers to see", and it is the
// reason `publicWhatsappE164` is here while `phoneE164`'s sibling fields are
// not: the first is the number she chose to put on /b/<slug>, the second is
// the one her own students were always shown.

export type StudentTeacherSummary = {
  id: string;
  name: string;
  photoUrl: string | null;
  targetLanguage: string | null;
};

export type StudentTeacherProfile = StudentTeacherSummary & {
  email: string;
  phoneE164: string | null;
  /** The number she published on her booking page, or null — see the header. */
  publicWhatsappE164: string | null;
  timezone: string;
  teachingLanguage: string;
  headline: string | null;
  bio: string | null;
  bookingSlug: string;
};

/** The next class this student still has on the calendar with this teacher. */
export type StudentNextClass = {
  id: string;
  scheduledStart: Date;
  durationMin: number;
};

const TEACHER_SELECT = {
  id: true,
  name: true,
  email: true,
  phoneE164: true,
  publicWhatsappE164: true,
  timezone: true,
  teachingLanguage: true,
  targetLanguage: true,
  headline: true,
  bio: true,
  photoPath: true,
  updatedAt: true,
  bookingSlug: true,
} as const;

type SelectedTeacher = {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  publicWhatsappE164: string | null;
  timezone: string;
  teachingLanguage: string;
  targetLanguage: string | null;
  headline: string | null;
  bio: string | null;
  photoPath: string | null;
  updatedAt: Date;
  bookingSlug: string;
};

function toSummary(teacher: SelectedTeacher): StudentTeacherSummary {
  return {
    id: teacher.id,
    name: teacher.name,
    photoUrl: teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime()),
    targetLanguage: teacher.targetLanguage,
  };
}

function toProfile(teacher: SelectedTeacher): StudentTeacherProfile {
  return {
    ...toSummary(teacher),
    email: teacher.email,
    phoneE164: teacher.phoneE164,
    publicWhatsappE164: teacher.publicWhatsappE164,
    timezone: teacher.timezone,
    teachingLanguage: teacher.teachingLanguage,
    headline: teacher.headline,
    bio: teacher.bio,
    bookingSlug: teacher.bookingSlug,
  };
}

/** Every teacher the signed-in student currently studies with, deduped and
 * name-sorted. Excludes archived ("dar de baja") pairings — same as the rest
 * of the active portal. */
export async function listStudentTeachers(student: {
  id: string;
  email: string | null;
}): Promise<StudentTeacherSummary[]> {
  const studentIds = await studentIdentityIds(student);
  const rows = await prisma.teacherStudent.findMany({
    where: { studentId: { in: studentIds }, archivedAt: null },
    select: { teacher: { select: TEACHER_SELECT } },
  });
  const byId = new Map<string, StudentTeacherSummary>();
  for (const row of rows) {
    if (!byId.has(row.teacher.id)) byId.set(row.teacher.id, toSummary(row.teacher));
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A single teacher's student-facing profile. Not archive-filtered — a link
 * from an existing booking/message thread should keep resolving even after
 * the pairing is later archived; only the "My teachers" list hides those. */
export async function getStudentTeacherProfile(
  student: { id: string; email: string | null },
  teacherId: string,
): Promise<StudentTeacherProfile | null> {
  const studentIds = await studentIdentityIds(student);
  const ts = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
    select: { teacher: { select: TEACHER_SELECT } },
  });
  return ts ? toProfile(ts.teacher) : null;
}

/** How many teachers the student currently studies with. Cheaper than
 * `listStudentTeachers` when the caller only needs to know whether "my
 * teachers" is a list worth going back to — the single-teacher case redirects
 * straight past that page, so a back link pointing at it would bounce the
 * student right back to where they were standing. */
export async function countStudentTeachers(student: {
  id: string;
  email: string | null;
}): Promise<number> {
  const studentIds = await studentIdentityIds(student);
  const rows = await prisma.teacherStudent.findMany({
    where: { studentId: { in: studentIds }, archivedAt: null },
    select: { teacherId: true },
    distinct: ["teacherId"],
  });
  return rows.length;
}

/** The student's next scheduled class with this teacher, or null. Same
 * identity-set scoping as everything else here, so a class booked under a
 * sibling student row still counts. */
export async function getNextClassWithTeacher(
  student: { id: string; email: string | null },
  teacherId: string,
  now: Date = new Date(),
): Promise<StudentNextClass | null> {
  const studentIds = await studentIdentityIds(student);
  const booking = await prisma.booking.findFirst({
    where: {
      teacherId,
      studentId: { in: studentIds },
      status: "scheduled",
      scheduledStart: { gt: now },
    },
    orderBy: { scheduledStart: "asc" },
    select: {
      id: true,
      scheduledStart: true,
      package: { select: { classDurationMin: true } },
    },
  });
  if (!booking) return null;
  return {
    id: booking.id,
    scheduledStart: booking.scheduledStart,
    durationMin: booking.package.classDurationMin,
  };
}
