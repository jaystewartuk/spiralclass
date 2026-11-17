import type { Booking, Student, Teacher } from "@prisma/client";

// Which language a lesson is in, for everything downstream of a class's
// speech: the tag stored on its transcript, the language the prep brief and
// the insights grade against, and the language a student's spoken homework
// answer is recognised in.
//
// This used to be a constant, `DEFAULT_LESSON_LANGUAGE = "es"`, from before the
// platform was language-first (D-72). It was right for the one teacher live at
// the time and wrong for every teacher who does not teach Spanish: a
// French class was stored, briefed and graded as a Spanish one.
//
// Two named facts, first non-null wins (D-72 — neither is derived from the
// other): `targetLanguage` is what she TEACHES, the subject itself, and is the
// right answer whenever she has set it; `teachingLanguage` is what she teaches
// IN, the language she speaks in class, and is the honest fallback while her
// subject is unset because it is the language the class actually heard. Never
// `locale` (what she reads) or `bookingPageLocale` (what her buyers read).
//
// One tag per transcript is an approximation: two people speak in a class,
// possibly in two languages. The transcript's text is whatever each speaker's
// recogniser heard, in that speaker's own language (classSpokenLanguages
// below); the tag names the lesson, not every line.
export function lessonLanguage(
  teacher: Pick<Teacher, "targetLanguage" | "teachingLanguage">,
): string {
  return teacher.targetLanguage ?? teacher.teachingLanguage;
}

// The language each participant SPEAKS in this class: a per-class override if
// the teacher set one, else her teaching language and the student's own
// language. The one answer for both the live captions (lib/captions/
// class-access.ts) and the legacy audio pipeline's ASR (pipeline.ts), so an
// audio file is never sent to a vendor tagged with a language nobody spoke.
export function classSpokenLanguages(
  booking: Pick<Booking, "teacherLanguageOverride" | "studentLanguageOverride"> & {
    teacher: Pick<Teacher, "teachingLanguage">;
    student: Pick<Student, "nativeLanguage">;
  },
): { teacher: string; student: string } {
  return {
    teacher: booking.teacherLanguageOverride ?? booking.teacher.teachingLanguage,
    student: booking.studentLanguageOverride ?? booking.student.nativeLanguage,
  };
}
