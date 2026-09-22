import { prisma } from "@/lib/prisma";
import { CLASS_CONTENT_MAX_REVISIONS, type ClassContentSource } from "@/lib/materials/config";

// Version history (task 5), generalized by the ClassContent/LibraryMaterial
// merge (D-69) from a per-booking log to a per-material one — a separate
// append-only log, not a version of the material row itself. Today this is
// only ever exercised by the booking-scoped "class content" material (the one
// whose body is edited in place), but any material with a body could grow
// this history without a schema change.
//
// saveBookingContentMaterial (materials/handlers.ts) calls snapshotRevision()
// with the body it's about to OVERWRITE, right before the upsert, so a
// regenerate-and-save or an edit that goes wrong stays recoverable.

export type MaterialRevisionRow = {
  id: string;
  body: string;
  source: ClassContentSource;
  createdAt: Date;
};

// Snapshots the outgoing body, then prunes anything past the per-material cap
// (oldest first) so the log can't grow unbounded on a material that's
// regenerated/edited constantly.
export async function snapshotMaterialRevision(input: {
  teacherId: string;
  materialId: string;
  body: string;
  source: ClassContentSource;
}): Promise<void> {
  await prisma.materialRevision.create({
    data: {
      materialId: input.materialId,
      teacherId: input.teacherId,
      body: input.body,
      source: input.source,
    },
  });

  const excess = await prisma.materialRevision.findMany({
    where: { materialId: input.materialId },
    orderBy: { createdAt: "desc" },
    skip: CLASS_CONTENT_MAX_REVISIONS,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.materialRevision.deleteMany({
      where: { id: { in: excess.map((r) => r.id) } },
    });
  }
}

// Most-recent-first, capped the same as the storage ceiling — there's never
// more than that many rows to read anyway.
export async function listMaterialRevisions(input: {
  teacherId: string;
  materialId: string;
}): Promise<MaterialRevisionRow[]> {
  const rows = await prisma.materialRevision.findMany({
    where: { teacherId: input.teacherId, materialId: input.materialId },
    orderBy: { createdAt: "desc" },
    take: CLASS_CONTENT_MAX_REVISIONS,
    select: { id: true, body: true, source: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, source: r.source as ClassContentSource }));
}
