import type { StringKey } from "@/lib/i18n-translate";

/**
 * The ways a teacher's booking can fail, as codes rather than sentences.
 *
 * `createTeacherBooking` used to return the finished English or Spanish string
 * itself, chosen by `locale === "en" ? … : …`. That ternary makes English the
 * answer for exactly one locale and Spanish the answer for every other,
 * present and future — so the French teacher this platform already has read
 * her booking errors in Spanish, while five perfectly good `teacherBook.error.*`
 * catalog entries sat unused. (The same shape, in the same words, is the bug
 * `dual-zone.ts` calls out for its own relative-day labels.)
 *
 * The action returns one of these; the client component that renders the
 * confirmation dialog turns it into a sentence with the `t` it already holds.
 * That also keeps the wording out of the server response entirely, so a
 * teacher switching language sees the new language on the next render rather
 * than the one the server happened to resolve when the action ran.
 */
export const TEACHER_BOOKING_ERRORS = [
  "invalid",
  "package-not-found",
  "package-exhausted",
  "package-expired",
  "slot-unavailable",
  "slot-taken",
] as const;

export type TeacherBookingError = (typeof TEACHER_BOOKING_ERRORS)[number];

const KEYS: Record<TeacherBookingError, StringKey> = {
  invalid: "teacherBook.error.invalid",
  "package-not-found": "teacherBook.error.package-not-found",
  "package-exhausted": "teacherBook.error.package-exhausted",
  "package-expired": "teacherBook.error.package-expired",
  "slot-unavailable": "teacherBook.error.slot-unavailable",
  "slot-taken": "teacherBook.error.slot-taken",
};

/**
 * The catalog key for a failure code.
 *
 * Unrecognised input resolves to the slot-unavailable wording rather than
 * throwing: this runs inside render, on a value that crossed a server-action
 * boundary, and a stale client bundle meeting a newer code should still show
 * the teacher a sentence.
 */
export function teacherBookingErrorKey(code: string): StringKey {
  return KEYS[code as TeacherBookingError] ?? KEYS["slot-unavailable"];
}
