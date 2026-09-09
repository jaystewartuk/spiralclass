// Lightweight env-based feature flags for dark-launching.
//
// Mirrors the enablement-gate pattern in lib/pronunciation/config.ts: a flag is
// a single env var read straight from process.env and parsed as 1 | true | on
// (anything else, including unset, is off). Reading process.env directly means a
// flag check never depends on the whole env schema validating.
//
// Convention: name the env var FLAG_<SCREAMING_SNAKE>. Set it per environment in
// Vercel — leave it unset (off) in Production while it's on in the main/preview
// scope, so a feature can be merged to main and exercised on preview without
// being exposed to production students. Promote, then flip it on in Production.
//
// Usage:
//   import { flagEnabled } from "@/lib/flags";
//   if (flagEnabled("FLAG_NEW_BOOKING_FLOW")) { ... }
export function flagEnabled(envVar: string): boolean {
  const raw = process.env[envVar]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
