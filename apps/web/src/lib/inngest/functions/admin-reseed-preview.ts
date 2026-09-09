import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { writeOverride } from "@/lib/audit";
import { isProductionDeployment } from "@/lib/env";
import { UAT_OVERRIDE_TARGET_IDS } from "@/lib/uat/env-targets";
// Reuses the CLI seed script's real Supabase-backed entry point as-is —
// see the comment on `main`'s export in scripts/seed.ts. Deliberately NOT a
// new Supabase client of our own; this is the existing coupling (Auth Admin
// API for account provisioning, pending the D-40 better-auth cutover), not a
// new one introduced by /admin/uat (D-55).
import { main as runPreviewSeed } from "../../../../scripts/seed";

// Triggered by the /admin/uat "Reseed preview" button (apps/actions/admin-uat.ts).
// Reseeding is slow/bulk (many teachers/students), so it runs as a background
// job rather than blocking the admin request — matches the codebase's
// existing async-side-effect convention (e.g. transfer-on-paid.ts).
//
// Preview-only, checked THREE times independently: assertReseedAllowed() in
// the server action before the event is even sent, isProductionDeployment()
// here, and seedAll()'s own assertNotProductionTarget() (scripts/seed.ts,
// checks the actual DB connection string's project ref) inside the seed
// itself — the last of these is the real backstop, since it inspects what
// the running process is actually connected to rather than trusting a flag.
export const adminReseedPreviewFn = inngest.createFunction(
  {
    id: "admin-reseed-preview",
    retries: 1,
    triggers: [{ event: "admin/uat.reseed-preview" }],
  },
  ({ event, step }) => adminReseedPreviewHandler({ event, step: step as unknown as ReseedStep }),
);

// Extracted so the pg-boss event definition (lib/jobs/events.ts) runs the same
// body (Phase 2a). Only step.run is used, so a `{ run: (id, fn) => fn() }` shim
// is exact.
type ReseedStep = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export async function adminReseedPreviewHandler({
  event,
  step,
}: {
  event: { data: unknown };
  step: ReseedStep;
}) {
  if (isProductionDeployment()) {
    throw new Error("Refusing to run the preview reseed from a production deployment.");
  }

  const data = event.data as {
    requestedByAdminId: string;
    bulkTeachers?: number;
    studentsPerBulkTeacher?: number;
  };

  const requester = await step.run("load-requester", async () => {
    const row = await prisma.adminUser.findUnique({
      where: { id: data.requestedByAdminId },
      select: { id: true, email: true, role: true },
    });
    return row ?? null;
  });

  let summary: { teachers: number; students: number };
  try {
    summary = await step.run("seed-preview", () =>
      runPreviewSeed({
        bulkTeachers: data.bulkTeachers,
        studentsPerBulkTeacher: data.studentsPerBulkTeacher,
      }),
    );
  } catch (err) {
    await step.run("record-failure", () =>
      writeOverride({
        teacherId: null,
        targetType: "system",
        targetId: UAT_OVERRIDE_TARGET_IDS.reseedPreview,
        action: "reseed_preview_failed",
        reason: (err as Error).message,
        actor: requester,
      }),
    );
    throw err;
  }

  await step.run("record-completion", () =>
    writeOverride({
      teacherId: null,
      targetType: "system",
      targetId: UAT_OVERRIDE_TARGET_IDS.reseedPreview,
      action: "reseed_preview_completed",
      reason: "background job finished",
      after: summary,
      actor: requester,
    }),
  );
}
