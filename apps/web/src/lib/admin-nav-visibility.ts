import { hasCapability, type AdminCapability } from "@/lib/admin-capabilities";
import type { AdminRole } from "@prisma/client";

// Pure nav-visibility logic, split out of app/admin/layout.tsx so it's
// testable without pulling in that file's Server Component / analytics
// dependencies (D-55).

// Sidebar grouping (D-6x supercharged nav) — replaces the old binary
// primary/secondary split (inline bar vs. account dropdown) now that every
// destination lives in one grouped sidebar instead of two places.
export type NavSection = "overview" | "people" | "money" | "operations" | "admin";

export type NavItem = {
  href: string;
  label: string;
  minRole: AdminRole;
  // Alternate path to visibility alongside `minRole` — see canSee().
  capability?: AdminCapability;
  section: NavSection;
};

// Role hierarchy (descending privilege). Higher tiers automatically satisfy
// lower-tier `minRole` requirements. `tester`/`engineer` rank below every
// existing tier on purpose — they're narrow, capability-gated roles, not a
// rung on this ladder; access comes only from an explicitly granted
// capability, never from rank.
export const ROLE_RANK: Record<AdminRole, number> = {
  superadmin: 3,
  finance: 2,
  support: 1,
  tester: 0,
  engineer: 0,
};

export function canSee(actor: { role: AdminRole }, item: NavItem): boolean {
  return (
    ROLE_RANK[actor.role] >= ROLE_RANK[item.minRole] ||
    (item.capability != null && hasCapability(actor, item.capability))
  );
}
