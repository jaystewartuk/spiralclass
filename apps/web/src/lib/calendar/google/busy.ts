import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { SlotBlockedDate } from "@/lib/slots";

// Reads a teacher's imported Google busy intervals in the shape the slot
// generator already understands (`SlotBlockedDate`), so callers just merge the
// result into the `blockedDates` they pass to generateSlots. Returns [] when
// the teacher hasn't connected Google (or busy-import is dormant), so it's a
// zero-cost no-op until the feature is enabled.
export async function loadGoogleBusyBlocks(
  teacherId: string,
  db: Pick<PrismaClient, "googleBusyInterval"> = defaultPrisma,
): Promise<SlotBlockedDate[]> {
  const rows = await db.googleBusyInterval.findMany({
    where: { teacherId },
    select: { startsAt: true, endsAt: true },
  });
  return rows.map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
}
