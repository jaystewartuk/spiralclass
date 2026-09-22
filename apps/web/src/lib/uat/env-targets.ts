// Shared target-environment plumbing for /admin/uat (D-55): which base URL
// the probe/reseed hit, and the guard that keeps Reseed preview-only. Kept
// in one place so every UAT action agrees on what "preview" vs "production"
// means.
import { isProductionDeployment } from "@/lib/env";

export type UatTargetEnv = "preview" | "production";

export const UAT_TARGET_BASE_URL: Record<UatTargetEnv, string> = {
  preview: "https://preview.spiralclass.com",
  production: "https://spiralclass.com",
};

// Reseed must never run against production, regardless of which env the
// admin UI has selected. Checked in the server action AND belt-and-suspenders
// again in the Inngest function that does the actual work — seedAll()'s own
// assertNotProductionTarget() (scripts/seed.ts) is a third, DB-level guard.
export function assertReseedAllowed(env: UatTargetEnv): void {
  if (env !== "preview" || isProductionDeployment()) {
    throw new Error("Reseed is only allowed against preview, from a non-production deployment.");
  }
}

// `Override.targetId` is a real Postgres UUID column — these actions have no
// underlying entity, so each gets a fixed sentinel UUID (same treatment as
// lib/admin.ts's BOOTSTRAP_ACTOR_ID) rather than a plain string, which
// Postgres rejects outright (P2023).
export const UAT_OVERRIDE_TARGET_IDS = {
  probe: "00000000-0000-0000-0000-000000000101",
  posthogCheck: "00000000-0000-0000-0000-000000000102",
  stripeCheck: "00000000-0000-0000-0000-000000000103",
  reseedPreview: "00000000-0000-0000-0000-000000000104",
  clearChecklist: "00000000-0000-0000-0000-000000000105",
} as const;
