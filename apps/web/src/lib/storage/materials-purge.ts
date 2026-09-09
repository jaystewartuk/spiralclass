import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "./provider";
import { MATERIALS_BUCKET } from "./signed-urls";

// — class materials auto-purge. One year after a class ends, file
// attachments come down: the storage object is deleted (best-effort) and the
// row is removed. Scoped to booking-scoped file attachments only (bookingId
// set, storagePath set — D-69 merge of the old class_materials table),
// whether on a push schedule or "always visible" (sendTiming set or null); a
// reusable library item (bookingId null) or a class's content (body set,
// never a storagePath) is never touched by this job — storagePath alone
// already excludes those. URL-only attachments (linkUrl with no
// storage_path) aren't touched either — those reference external resources
// we don't control.
//
// The window is deliberately long: materials are revision resources a
// student may come back to, and storage is cheap relative to that value.
// This purge is only a backstop against truly abandoned files, not a
// cost-control measure.
//
// Pure-handler-takes-deps split: tests pass in-mem fakes; production wires
// the real Prisma + the app storage provider. Idempotent — running twice in
// the same window is a no-op on the second pass since the rows are already
// gone.

const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export type MaterialsPurgeDeps = {
  prisma: Pick<PrismaClient, "libraryMaterial">;
  storage: StorageProvider | null;
  now?: () => Date;
};

export type MaterialsPurgeOutcome = {
  scanned: number;
  rowsDeleted: number;
  storageDeleted: number;
  storageErrors: number;
};

export async function purgeExpiredMaterials(
  deps: MaterialsPurgeDeps,
): Promise<MaterialsPurgeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - RETENTION_MS);

  // Only file-backed, booking-scoped materials are eligible (storagePath set;
  // bookingId set) — sendTiming can be set (scheduled) or null (always
  // visible); either way it's an attachment, never the content row (which has
  // no storagePath). URL-only attachments (linkUrl only) fall through. The
  // booking join enforces the retention rule against scheduled_end so
  // cancelled-but-never-completed classes also clean up.
  const candidates = await deps.prisma.libraryMaterial.findMany({
    where: {
      storagePath: { not: null },
      bookingId: { not: null },
      booking: { scheduledEnd: { lt: cutoff } },
    },
    select: {
      id: true,
      storagePath: true,
    },
  });

  let rowsDeleted = 0;
  let storageDeleted = 0;
  let storageErrors = 0;

  for (const m of candidates) {
    if (m.storagePath && deps.storage) {
      const { error } = await deps.storage.remove(MATERIALS_BUCKET, [m.storagePath]);
      if (error) {
        storageErrors += 1;
      } else {
        storageDeleted += 1;
      }
    }
    await deps.prisma.libraryMaterial.delete({ where: { id: m.id } });
    rowsDeleted += 1;
  }

  return {
    scanned: candidates.length,
    rowsDeleted,
    storageDeleted,
    storageErrors,
  };
}
