import type { Prisma, PrismaClient } from "@prisma/client";
import { enqueueLibraryMaterialAssigned, enqueueMaterialsSend } from "./enqueue";
import { emitNotificationQueued } from "./events";
import { logger } from "@/lib/logger";

const log = logger({ surface: "library" });

// Class materials.
//
// A small wrapper around enqueueMaterialsSend that, given a booking + a
// timing slot, finds the matching scheduled materials (LibraryMaterial rows
// with this booking_id and this send_timing — D-69 merge of the old
// class_materials table) and queues one materials_send notification per
// attached material. Used by the Inngest reminder + confirmation paths so the
// materials ride alongside the existing student-facing message at the
// configured cadence.
//
// Returns the notification ids so callers can emit notification.queued
// events post-commit (mirrors the rest of the producer contract).

type Tx = Prisma.TransactionClient | PrismaClient;

export type MaterialTiming = "confirmation" | "t_5d" | "t_24h" | "t_1h";

export async function enqueueMaterialsForTiming(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    bookingId: string;
    timing: MaterialTiming;
  },
): Promise<string[]> {
  const materials = await tx.libraryMaterial.findMany({
    where: {
      bookingId: input.bookingId,
      sendTiming: input.timing,
    },
    select: { id: true, linkUrl: true, storagePath: true },
  });
  if (materials.length === 0) return [];

  // Per-material dedup, keyed on the libraryMaterialId each materials_send row
  // records in its metadata. The 24h/1h timings are already protected upstream —
  // maybeEnqueueReminder short-circuits on its own reminder row before it ever
  // reaches here — but `t_5d` has no reminder row to anchor on since the 5-day
  // class reminder was removed, so the scan re-evaluates that mark on every tick
  // and would otherwise re-queue the same material each time. One booking's
  // notification rows are a handful, so this filters in memory rather than
  // reaching for a JSON-path query.
  const alreadySent = await tx.notification.findMany({
    where: {
      teacherId: input.teacherId,
      bookingId: input.bookingId,
      templateName: "materials_send",
    },
    select: { metadata: true },
  });
  const sentMaterialIds = new Set(
    alreadySent
      .map((n) => (n.metadata as { libraryMaterialId?: unknown } | null)?.libraryMaterialId)
      .filter((id): id is string => typeof id === "string"),
  );

  const notificationIds: string[] = [];
  for (const m of materials) {
    if (sentMaterialIds.has(m.id)) continue; // already queued on an earlier tick
    const fallbackUrl = m.linkUrl ?? null;
    if (!m.storagePath && !fallbackUrl) continue; // bad data — skip silently
    const id = await enqueueMaterialsSend(tx, {
      teacherId: input.teacherId,
      studentId: input.studentId,
      bookingId: input.bookingId,
      libraryMaterialId: m.id,
      storagePath: m.storagePath,
      materialsUrl: fallbackUrl,
    });
    notificationIds.push(id);
  }
  return notificationIds;
}

// Account-level material assignment notification. Enqueues one
// library_material_assigned row and emits the notification.queued event so the
// dispatcher fires immediately — mirroring the inline enqueue+emit the
// class-materials upload action does. Self-contained (enqueue + emit) because
// the assign entry point writes outside a transaction; a failed emit is
// logged, not fatal — the row drains
// on the next manual re-emit.
export async function notifyLibraryMaterialAssigned(
  prisma: PrismaClient,
  input: { teacherId: string; studentId: string; libraryMaterialId: string },
): Promise<void> {
  const id = await enqueueLibraryMaterialAssigned(prisma, input);
  try {
    await emitNotificationQueued({ notificationId: id, teacherId: input.teacherId });
  } catch (err) {
    log.warn("materials-assigned emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
