// Quick-pick IANA zones for the timezone combobox, spanning the regions a
// teacher or student can actually be in — which is anywhere.
//
// This is a convenience list, never a constraint: the onboarding client
// auto-detects the browser zone and seeds the input with it, and the field
// accepts any valid IANA id, so a zone missing from this list costs a few
// keystrokes rather than blocking a signup. It used to be the Mexican zones
// plus a handful of "common international teachers", which made every teacher
// outside Latin America type hers by hand on the very first screen.
//
// Ordered by region, roughly west to east, so the list reads as a map rather
// than as a ranking of markets.
export const COMMON_TIMEZONES = [
  // Americas
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Tijuana",
  "America/Hermosillo",
  "America/Chihuahua",
  "America/Mazatlan",
  "America/Mexico_City",
  "America/Monterrey",
  "America/Merida",
  "America/Cancun",
  "America/Guatemala",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Buenos_Aires",
  "America/Montevideo",
  "America/Sao_Paulo",
  // Europe & Africa
  "Atlantic/Canary",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  // Asia & Oceania
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Manila",
  "Asia/Hong_Kong",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  // The zone of last resort — see FALLBACK_TIMEZONE in @spiralclass/shared.
  "UTC",
];
