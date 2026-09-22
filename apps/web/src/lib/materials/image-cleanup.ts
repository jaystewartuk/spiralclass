import { collectMaterialImageKeys, materialImageSrc, parseMaterialDoc } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { removeMaterialImages } from "@/lib/storage/material-images";

// Frees the images a hard-deleted material embedded — the body-image
// counterpart to `removeMaterialObject` freeing a material's file attachment.
//
// WHY IT REFERENCE-COUNTS FIRST. Nothing stops one picture appearing in two
// materials: duplicating a section copies its Markdown verbatim, and a teacher
// can paste the same block anywhere. Deleting the object outright would then
// blank an image inside a material she never touched — a silent, unrecoverable
// data loss in a document she has no reason to re-check. So a key is only
// swept once no OTHER material of hers still references it.
//
// The check is a `contains` scan over the teacher's own bodies. That is a
// sequential scan, but scoped to one teacher's library (tens to low hundreds
// of rows) and run only on an explicit hard delete — cheap enough that a
// dedicated join table for image references would be storing state to answer a
// question the bodies already answer, and would then need its own consistency
// guarantees on every save.
//
// Best-effort throughout, exactly like the file-attachment path: a leaked
// object costs pennies of storage, whereas a throw here would fail a delete
// the teacher has already been told succeeded.

export async function removeUnreferencedMaterialImages(opts: {
  teacherId: string;
  /** The material being deleted — excluded from the "still referenced?" scan,
   * since its own row may or may not be gone yet depending on call order. */
  materialId: string;
  body: string | null;
}): Promise<void> {
  const { teacherId, materialId, body } = opts;
  if (!body) return;

  const keys = collectMaterialImageKeys(parseMaterialDoc(body));
  if (!keys.length) return;

  const orphans: string[] = [];
  for (const key of keys) {
    const stillUsed = await prisma.libraryMaterial.findFirst({
      where: {
        teacherId,
        id: { not: materialId },
        // Match on the full `material-image:<key>` spelling, not the bare key:
        // the key alone could appear inside an unrelated link URL in some
        // other body and wrongly protect an object that is genuinely orphaned.
        body: { contains: materialImageSrc(key) },
      },
      select: { id: true },
    });
    if (!stillUsed) orphans.push(key);
  }

  await removeMaterialImages(orphans);
}
