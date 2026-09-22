// Tunables for the Teacher → Student invitation flow (D-83). Named constants,
// mirroring the config-object convention used across the codebase, so the
// lifecycle windows live in one place.

// How long an invitation link stays valid from its creation. 30 days matches
// the new-teacher trial window and is comfortably longer than a teacher needs
// to nudge a student in person.
export const INVITATION_TTL_DAYS = 30;

// Minimum gap between resends of the same invitation, so an impatient teacher
// (or a double-clicked button) can't spam a student's inbox.
export const INVITATION_RESEND_COOLDOWN_MINUTES = 60;

// How many students a teacher can invite in one bulk operation. A generous cap
// that still bounds a single request's fan-out (email sends run inline).
export const INVITATION_BULK_MAX = 200;

// Age at which a still-pending, still-unaccepted invitation earns the teacher a
// "these students haven't accepted yet" nudge. Fired at most once per invitation
// (the cron dedups on the notification row).
export const INVITATION_NUDGE_AFTER_DAYS = 3;

// URL path segment the emailed accept link lives under (web page + mobile deep
// link both resolve `/i/<token>`). Kept short for tidy links.
export const INVITATION_PATH_PREFIX = "/i";
