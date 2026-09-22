// Maintenance mode (D-76). A single env flag takes the app offline for a
// planned window (a destructive migration, an infra cutover, a Stripe-entity
// credential swap), enforced in middleware.
//
// Deliberately env-var driven (not a DB row): the primary use case is database
// maintenance, and a flag you can't read while the DB is down is self-defeating.
// It follows the same "flip an env var, no code release" shape as the
// flagEnabled() convention (lib/flags.ts) — read straight from process.env so a
// maintenance check never depends on the whole env schema validating and works
// in Edge middleware.

import type { NextRequest } from "next/server";
import { flagEnabled } from "@/lib/flags";

// Cookie/query name an operator uses to punch through the wall. A request whose
// ?maintenance_bypass=<MAINTENANCE_BYPASS_TOKEN> matches the configured token
// gets a cookie set so the rest of their navigation stays live — letting them
// verify the real site before flipping maintenance back off.
export const MAINTENANCE_BYPASS_COOKIE = "maintenance_bypass";
export const MAINTENANCE_BYPASS_QUERY = "maintenance_bypass";

// Set MAINTENANCE_MODE=1|true|on to take the apps offline.
export function isMaintenanceMode(): boolean {
  return flagEnabled("MAINTENANCE_MODE");
}

// Optional operator-supplied copy shown on the wall.
export function maintenanceMessage(): string | undefined {
  const raw = process.env.MAINTENANCE_MESSAGE?.trim();
  return raw ? raw : undefined;
}

// Optional ETA string (free-form, e.g. "18:00 CST") shown on the wall.
export function maintenanceUntil(): string | undefined {
  const raw = process.env.MAINTENANCE_UNTIL?.trim();
  return raw ? raw : undefined;
}

// The shared secret an operator appends as ?maintenance_bypass=<token>.
// Undefined (unset/blank) means bypass is disabled — no one gets through.
export function maintenanceBypassToken(): string | undefined {
  const raw = process.env.MAINTENANCE_BYPASS_TOKEN?.trim();
  return raw ? raw : undefined;
}

// Does this request already carry a valid bypass cookie (operator already
// punched through earlier)? False when no token is configured.
export function hasMaintenanceBypassCookie(request: NextRequest): boolean {
  const token = maintenanceBypassToken();
  if (!token) return false;
  return request.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value === token;
}

// Does this request carry the bypass token as a query param (operator entry)?
// False when no token is configured.
export function hasMaintenanceBypassQuery(request: NextRequest): boolean {
  const token = maintenanceBypassToken();
  if (!token) return false;
  return request.nextUrl.searchParams.get(MAINTENANCE_BYPASS_QUERY) === token;
}

// Paths that must stay reachable even while maintenance is on:
//   - /maintenance         the wall itself (else the rewrite loops)
//   - /api/health          external monitors' DB-readiness probe (must stay 200)
//   - /api/health/live     Fly's own DB-less liveness check (must stay 200)
//   - /api/csp-report, /monitoring  telemetry sinks (also matcher-excluded)
// Both /api/health and /api/health/live are also excluded from the
// middleware matcher itself (src/middleware.ts), so this function never
// actually runs for them today — listed here anyway so the allowlist stays
// correct if that matcher exclusion is ever narrowed.
export function isMaintenanceAllowlisted(path: string): boolean {
  return (
    path === "/maintenance" ||
    path === "/api/health" ||
    path === "/api/health/live" ||
    path === "/api/csp-report" ||
    path.startsWith("/monitoring")
  );
}
