"use server";

import { requireOnboardedTeacher } from "@/lib/auth";
import { isOpenedFor, recordClassMaterialUse } from "@/lib/materials/record-use";
import { logger } from "@/lib/logger";

const log = logger({ surface: "class-material-use" });

// Records that the teacher opened a material during a class — the write behind
// the student page's materials history and the composer's "continue from a
// previous class" picker. Teacher-only and student-invisible: it neither
// attaches the material to the class nor sends anything, which is exactly why
// it is not the attach action (see lib/materials/record-use.ts).
//
// Fire-and-forget by contract: the material is already open on her screen by
// the time this runs, so a failure must never surface as an error or undo the
// open. Returns void for the same reason — there is nothing a caller could
// usefully do with a result.
export async function recordClassMaterialUseAction(formData: FormData): Promise<void> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const rawOpenedFor = String(formData.get("openedFor") ?? "teacher");
  const openedFor = isOpenedFor(rawOpenedFor) ? rawOpenedFor : "teacher";
  if (!bookingId || !materialId) return;

  try {
    const teacher = await requireOnboardedTeacher();
    const recorded = await recordClassMaterialUse({
      teacherId: teacher.id,
      bookingId,
      materialId,
      openedFor,
    });
    if (!recorded) {
      log.warn("class material use not recorded", { bookingId, materialId });
    }
  } catch (err) {
    log.warn("class material use failed", { bookingId, materialId, err: String(err) });
  }
}
