"use server";

import { prisma } from "@/lib/prisma";
import { requireTeacher } from "@/lib/auth";
import { revalidateAfterAction } from "@/lib/revalidate";

// Settings → Booking page → "Share progress with my students".
//
// Two things move together, deliberately, because the teacher is answering one
// question ("do my students see their own progress?") and would not thank us
// for a control that answered it only for people who sign up later:
//
//   1. `Teacher.shareProgressByDefault` — what a NEW pairing is created with
//      (lib/students/find-or-create.ts), and the capability the public booking
//      page gates its vocabulary-review promise on.
//   2. Every EXISTING `TeacherStudent.shareProgress` for this teacher.
//
// It applies in both directions on purpose. An asymmetric toggle — on
// backfilling everyone, off quietly leaving them shared — would mean a teacher
// who changed her mind had no way to act on it without visiting every student,
// and would leave the page promising something she had just turned off. The
// per-student control on the student detail page stays available for
// exceptions afterwards; this is the policy, that is the override.

export type ProgressSharingState = { ok?: boolean; shared?: boolean } | undefined;

export async function setProgressSharingAction(
  _prev: ProgressSharingState,
  formData: FormData,
): Promise<ProgressSharingState> {
  const teacher = await requireTeacher();
  const shared = formData.get("shared") === "on";

  await prisma.$transaction([
    prisma.teacher.update({
      where: { id: teacher.id },
      data: { shareProgressByDefault: shared },
    }),
    prisma.teacherStudent.updateMany({
      where: { teacherId: teacher.id },
      data: { shareProgress: shared },
    }),
  ]);

  revalidateAfterAction("/settings/booking-page");
  // The band on her public page is gated on this, so the cached page has to go
  // with it or the promise and the setting disagree until the next deploy.
  return { ok: true, shared };
}
