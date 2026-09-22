import type { StringKey } from "@/lib/i18n-translate";

/**
 * The ways a teacher's "change date and time" can fail, as codes rather than
 * sentences.
 *
 * Same reasoning as `@/lib/booking/teacher-booking-errors`, and the same bug
 * avoided: a server action that returns a finished string picks the reader's
 * language on the server, with a `locale === "en" ? … : …` ternary that makes
 * Spanish the answer for every locale that is not English — including the
 * French this platform already ships. The action returns a code; the client
 * component that renders the picker turns it into a sentence with the `t` it
 * already holds.
 */
export const TEACHER_RESCHEDULE_ERRORS = [
  "invalid",
  "booking-not-found",
  "not-scheduled",
  "past-slot",
  "same-slot",
  "package-expired",
  "package-not-found",
  "slot-unavailable",
  "slot-taken",
] as const;

export type TeacherRescheduleError = (typeof TEACHER_RESCHEDULE_ERRORS)[number];

const KEYS: Record<TeacherRescheduleError, StringKey> = {
  invalid: "teacherReschedule.error.invalid",
  "booking-not-found": "teacherReschedule.error.booking-not-found",
  "not-scheduled": "teacherReschedule.error.not-scheduled",
  "past-slot": "teacherReschedule.error.past-slot",
  "same-slot": "teacherReschedule.error.same-slot",
  "package-expired": "teacherReschedule.error.package-expired",
  "package-not-found": "teacherReschedule.error.package-not-found",
  "slot-unavailable": "teacherReschedule.error.slot-unavailable",
  "slot-taken": "teacherReschedule.error.slot-taken",
};

/**
 * The catalog key for a failure code.
 *
 * Unrecognised input resolves to the slot-unavailable wording rather than
 * throwing: this runs inside render, on a value that crossed a server-action
 * boundary, and a stale client bundle meeting a newer code should still show
 * the teacher a sentence.
 */
export function teacherRescheduleErrorKey(code: string): StringKey {
  return KEYS[code as TeacherRescheduleError] ?? KEYS["slot-unavailable"];
}
