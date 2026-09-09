import type { PrismaClient } from "@prisma/client";

// Slice 7a part 2 — abandoned-checkout cleanup.
//
// Every failed/abandoned Stripe Checkout leaves a Package + Payment row at
// status='pending'. Closes the CLAUDE.md gap: rows older than 7 days with
// no successful payment get hard-deleted. Active flows are unaffected
// because successful payments flip the package status away from 'pending'
// well before the 7-day window.
//
// Wise rows get a longer grace window (14 days) since the teacher
// reconciles manually and bank transfers can take longer than card
// charges. Either window expires → the package + its payments are
// hard-deleted via the existing cascade.
//
// Pure-handler-takes-deps split. Idempotent: a second run sees no
// candidates and no-ops.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Cap how many packages a single run will delete. Keeps the Inngest worker
// well inside its serverless time budget even if a large backlog of
// abandoned checkouts accumulates; the next scheduled run drains the rest.
// Idempotent, so partial drains across runs are safe.
const DEFAULT_MAX_DELETIONS = 500;

export type CleanupPendingDeps = {
  prisma: Pick<PrismaClient, "package">;
  now?: () => Date;
  /** Upper bound on deletions per run (defaults to {@link DEFAULT_MAX_DELETIONS}). */
  maxDeletions?: number;
};

export type CleanupPendingOutcome = {
  /** Candidate packages found this run (capped at maxDeletions). */
  scanned: number;
  /** Packages successfully deleted. */
  packagesDeleted: number;
  /**
   * Candidates that no longer matched the guard at delete time — a payment
   * settled or was marked-sent between the scan and the delete, so the guarded
   * deleteMany matched 0 rows. Left in place (not a failure).
   */
  skipped: number;
  /** Packages that failed to delete (transient DB errors); retried next run. */
  failed: number;
};

export async function cleanupAbandonedPendingPackages(
  deps: CleanupPendingDeps,
): Promise<CleanupPendingOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const maxDeletions = deps.maxDeletions ?? DEFAULT_MAX_DELETIONS;
  const stripeCutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const wiseCutoff = new Date(now.getTime() - FOURTEEN_DAYS_MS);

  // Defense-in-depth: a Package may have multiple Payments; we only delete
  // when *every* payment is also still pending (i.e., nothing actually
  // settled). Successful checkouts flip the package status off 'pending'
  // anyway, but a paranoid check costs nothing here.
  //
  // The cutoff is provider-aware: Stripe rows past 7d, Wise past 14d.
  // We model this by requiring that *every* pending payment on the
  // package satisfies its provider-specific cutoff.
  const candidates = await deps.prisma.package.findMany({
    where: {
      status: "pending",
      payments: {
        every: {
          status: "pending",
          // A student who marked a Wise transfer as sent has real money in
          // flight (the payment stays 'pending' until the teacher confirms).
          // Hard-deleting that package destroys the only record of the
          // transfer, so never treat a marked-sent row as abandoned.
          studentMarkedSentAt: null,
          OR: [
            { provider: "stripe", createdAt: { lt: stripeCutoff } },
            { provider: "manual_transfer", createdAt: { lt: wiseCutoff } },
          ],
        },
      },
    },
    select: { id: true },
    take: maxDeletions,
  });

  let packagesDeleted = 0;
  let skipped = 0;
  let failed = 0;
  for (const pkg of candidates) {
    try {
      // Guarded delete (TOCTOU): a Wise confirm / auto-reconcile can land
      // between the scan above and this delete, flipping the package to
      // 'active' and a payment to 'paid'. Re-assert the abandoned predicate in
      // the WHERE so we can't cascade-delete a now-active, paid package (which
      // would revoke the student's just-purchased classes). Payments
      // cascade-delete via the Payment.package FK (onDelete: Cascade).
      const res = await deps.prisma.package.deleteMany({
        where: {
          id: pkg.id,
          status: "pending",
          payments: { every: { status: "pending", studentMarkedSentAt: null } },
        },
      });
      if (res.count > 0) packagesDeleted += 1;
      else skipped += 1;
    } catch {
      // A transient delete failure must not abort the whole sweep — count it
      // and move on. The package stays a candidate and is retried next run.
      failed += 1;
    }
  }

  return {
    scanned: candidates.length,
    packagesDeleted,
    skipped,
    failed,
  };
}
