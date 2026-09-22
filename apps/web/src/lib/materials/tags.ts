import { prisma } from "@/lib/prisma";
import { resolveOwnedFocusTagIds } from "@/lib/focus-tags";

// Gap G1 (docs/features/library-materials.md) — replace-set sync of a
// material's focus tags. Shared by the web server actions and the mobile JSON
// API so both write through the exact same tenant-scoped validation. Posted
// ids are always re-resolved against the teacher's own active tags first —
// never trusted as-is. Works identically for a library-scoped material
// (bookingId null) or a booking-scoped one (bookingId set) — the join table
// (LibraryMaterialFocusTag) doesn't care which.
export async function syncLibraryMaterialFocusTags(
  teacherId: string,
  materialId: string,
  tagIds: string[],
): Promise<void> {
  const owned = await resolveOwnedFocusTagIds(teacherId, tagIds);
  await prisma.$transaction([
    prisma.libraryMaterialFocusTag.deleteMany({ where: { libraryMaterialId: materialId } }),
    ...(owned.length > 0
      ? [
          prisma.libraryMaterialFocusTag.createMany({
            data: owned.map((focusTagId) => ({ libraryMaterialId: materialId, focusTagId })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);
}
