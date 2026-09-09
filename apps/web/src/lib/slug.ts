import { randomBytes } from "crypto";

// Length bounds for the editable part of a booking slug (the "enlace de
// reservas"). The auto-generated slug appends a random suffix on top of a
// base capped at BOOKING_SLUG_MAX; a teacher editing it is bound by both.
export const BOOKING_SLUG_MIN = 3;
export const BOOKING_SLUG_MAX = 40;

// Slugs we never hand out even if normalization produces them: they either
// collide with a real path under /b or read as a system word. Kept small and
// lowercase — comparison is against the already-normalized candidate.
const RESERVED_BOOKING_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "b",
  "dashboard",
  "onboarding",
  "settings",
]);

// Normalize free-form input into a URL-safe slug candidate: lowercase, strip
// diacritics, collapse every run of non-alphanumerics to a single hyphen,
// trim leading/trailing hyphens, and cap the length. Shared by the
// auto-generator and the teacher-facing editor so both produce identical,
// predictable output.
export function normalizeBookingSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BOOKING_SLUG_MAX);
}

export type BookingSlugValidation =
  { ok: true; slug: string } | { ok: false; reason: "too-short" | "reserved" };

// Validate a teacher-supplied booking slug. We normalize first (so the
// teacher's intent survives stray spaces/capitals/accents), then enforce the
// length floor and reserved list. The unique-constraint check happens at the
// DB write — this is the cheap, offline gate. No "too-long" case: normalize
// already truncates to BOOKING_SLUG_MAX.
export function validateBookingSlug(input: string): BookingSlugValidation {
  const slug = normalizeBookingSlug(input);
  if (slug.length < BOOKING_SLUG_MIN) return { ok: false, reason: "too-short" };
  if (RESERVED_BOOKING_SLUGS.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true, slug };
}

// Build a URL-safe booking slug from the teacher's email local-part with a
// short random suffix for uniqueness. The base reuses normalizeBookingSlug so
// generated and edited slugs share one set of rules; the suffix keeps the
// auto-assigned slug collision-free at sign-up.
export function generateBookingSlug(email: string): string {
  const local = email.split("@")[0] ?? "teacher";
  const base = normalizeBookingSlug(local) || "teacher";
  const suffix = randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}
