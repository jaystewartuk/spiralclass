import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Recording that a material was opened during a class. Deliberately separate
// from attaching one (app/actions/booking-library-materials.ts): attaching is
// a promise to the STUDENT — it carries a send timing and rides the
// WhatsApp/email pipeline — whereas this is a private fact about the lesson.
// Routing "I pulled this up on the call" through the attach path would push a
// material to the student every time the teacher previewed one for herself.

export type OpenedFor = "teacher" | "student" | "both";

export function isOpenedFor(v: string): v is OpenedFor {
  return v === "teacher" || v === "student" || v === "both";
}

// A second open in the same class with a different audience means the material
// ended up in front of both of them; anything else keeps what is already
// recorded. Pure so the widening rule is testable on its own.
export function widenOpenedFor(prev: OpenedFor, next: OpenedFor): OpenedFor {
  return prev === next ? prev : "both";
}

/**
 * Idempotent per (booking, material): the first open in a class stamps
 * `openedAt`, later ones only widen `openedFor`. Tenant-scoped through the
 * booking AND the material, so neither id can reach outside the caller's own
 * data. Returns false when either id fails that check — callers treat this as
 * best-effort and never let it block opening the material.
 */
export async function recordClassMaterialUse(
  input: {
    teacherId: string;
    bookingId: string;
    materialId: string;
    openedFor: OpenedFor;
  },
  deps?: { db?: PrismaClient },
): Promise<boolean> {
  const db = deps?.db ?? prisma;
  const { teacherId, bookingId, materialId, openedFor } = input;
  if (!bookingId || !materialId) return false;

  const [booking, material] = await Promise.all([
    db.booking.findFirst({ where: { id: bookingId, teacherId }, select: { id: true } }),
    // A booking-scoped material must belong to THIS booking; a reusable
    // library item (bookingId null) is openable from any of her classes.
    db.libraryMaterial.findFirst({
      where: { id: materialId, teacherId, OR: [{ bookingId: null }, { bookingId }] },
      select: { id: true },
    }),
  ]);
  if (!booking || !material) return false;

  const existing = await db.classMaterialUse.findUnique({
    where: { bookingId_materialId: { bookingId, materialId } },
    select: { id: true, openedFor: true },
  });

  if (!existing) {
    // A concurrent open of the same material (two devices, or a double click)
    // races this insert; the unique index is the arbiter and a lost race is
    // already the outcome we want, so swallow it rather than surfacing a
    // failure for a record that now exists.
    try {
      await db.classMaterialUse.create({
        data: { teacherId, bookingId, materialId, openedFor },
      });
      return true;
    } catch {
      return false;
    }
  }

  const prev = isOpenedFor(existing.openedFor) ? existing.openedFor : "teacher";
  const widened = widenOpenedFor(prev, openedFor);
  if (widened !== prev) {
    await db.classMaterialUse.update({
      where: { id: existing.id },
      data: { openedFor: widened },
    });
  }
  return true;
}
