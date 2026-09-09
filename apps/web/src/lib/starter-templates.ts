import { createT, DEFAULT_LOCALE, type AppLocale, type StringKey } from "@spiralclass/shared";

// Package templates / P2 starter templates. Created on the teacher's first
// authenticated request — either via the sign-up action, or lazily in
// requireTeacher for users provisioned outside the signup flow (e.g.,
// Supabase dashboard). Names are resolved from the shared i18n catalog in
// the teacher's own locale rather than hardcoded — a teacher whose locale
// can't be determined at signup still sees Spanish names (STARTER_LOCALE
// below), not English ones, matching the rest of teacher-facing copy.
const STARTER_TEMPLATE_DEFS: Array<{
  nameKey: StringKey;
  classCount: number;
  priceMinorUnits: number;
  expirationMonths: number;
}> = [
  {
    nameKey: "web.onboarding.templates.starter.fourClasses",
    classCount: 4,
    priceMinorUnits: 120_000,
    expirationMonths: 1,
  },
  {
    nameKey: "web.onboarding.templates.starter.eightClasses",
    classCount: 8,
    priceMinorUnits: 220_000,
    expirationMonths: 2,
  },
  {
    nameKey: "web.onboarding.templates.starter.twelveClasses",
    classCount: 12,
    priceMinorUnits: 300_000,
    expirationMonths: 3,
  },
  {
    nameKey: "web.onboarding.templates.starter.twentyClasses",
    classCount: 20,
    priceMinorUnits: 480_000,
    expirationMonths: 5,
  },
];

// Seeded package names follow the platform default like every other piece of
// copy with no better signal. This was pinned to es-MX until 2026-08-25, on
// the reasoning that teacher-facing copy defaults to Spanish because Spanish
// was the launch market's language — which stopped being true of the product:
// teachers are anywhere and speak anything, so a signup whose Accept-Language
// says `pl` was being handed Spanish package names it could not read. Callers
// that know the teacher's locale (getPreferredLocale on web, the
// Accept-Language header on mobile) still pass it explicitly; this is only the
// answer when the request resolves nothing at all.

export type StarterTemplate = {
  name: string;
  classCount: number;
  priceMinorUnits: number;
  expirationMonths: number;
};

/** The four starter package templates, with names localized to `locale`
 * (defaulting to DEFAULT_LOCALE). Mirrors starterAvailabilityFor
 * below — a naive base plus a `*For` function that stamps in the
 * per-teacher value the base can't know ahead of time. */
export function starterTemplatesFor(locale: AppLocale = DEFAULT_LOCALE): StarterTemplate[] {
  const t = createT(locale);
  return STARTER_TEMPLATE_DEFS.map(({ nameKey, ...rest }) => ({ name: t(nameKey), ...rest }));
}

// Starter working hours, seeded on the teacher's first authenticated request
// alongside the starter templates. Without this a teacher who skips the
// onboarding availability step (the stepper lets you jump straight to the
// last step and Finish) ends up published with zero AvailabilityRule rows —
// a live booking link that shows no bookable slots. A normal working week —
// Mon–Fri 09:00–17:00 — and the onboarding form imports this same constant
// as its DEFAULT_RANGES, so the seeded rows always match what the step
// previews. `weekday` uses 0 = Sunday .. 6 = Saturday.
export const STARTER_AVAILABILITY = [
  { weekday: 1, startTime: "09:00", endTime: "17:00" },
  { weekday: 2, startTime: "09:00", endTime: "17:00" },
  { weekday: 3, startTime: "09:00", endTime: "17:00" },
  { weekday: 4, startTime: "09:00", endTime: "17:00" },
  { weekday: 5, startTime: "09:00", endTime: "17:00" },
];

// AvailabilityRule now carries the IANA zone its wall clock was written in
// (D-53), so the seed rows must be stamped with the teacher's zone at creation.
// Callers pass the same zone they set on the teacher row so the seeded hours
// mean 09:00 in the teacher's own zone, not whatever the server clock happens
// to be.
export function starterAvailabilityFor(
  timezone: string,
): Array<{ weekday: number; startTime: string; endTime: string; timezone: string }> {
  return STARTER_AVAILABILITY.map((r) => ({ ...r, timezone }));
}
