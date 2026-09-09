import type { AdminRole } from "@prisma/client";

// Narrow, non-technical admin capabilities, orthogonal to the rank ladder in
// lib/admin.ts (ROLE_RANK). `tester`/`engineer` rank BELOW `support` there so
// they see nothing via rank — access to any capability-gated page comes
// exclusively from being listed here. Add more capabilities as new tools
// ship; one map, one place to touch. See D-55.
export type AdminCapability = "uat:run" | "schema:view";

// Every capability, so superadmin implicitly gets new ones without needing a
// hand-updated entry below each time this list grows.
const ALL_CAPABILITIES: AdminCapability[] = ["uat:run", "schema:view"];

const ROLE_CAPABILITIES: Record<AdminRole, ReadonlySet<AdminCapability>> = {
  superadmin: new Set(ALL_CAPABILITIES),
  finance: new Set([]),
  support: new Set([]),
  tester: new Set(["uat:run"]),
  // `engineer` gets the read-only database ERD — a schema-exploration tool —
  // without inheriting anything else on the rank ladder.
  engineer: new Set(["uat:run", "schema:view"]),
};

export function hasCapability(actor: { role: AdminRole }, capability: AdminCapability): boolean {
  return ROLE_CAPABILITIES[actor.role].has(capability);
}
