"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

export type PackagePauseState = { error?: string; ok?: boolean } | undefined;

const schema = z.object({
  packageId: z.string().uuid(),
  intent: z.enum(["pause", "resume"]),
});

// Teacher-facing pause/resume for one of their own packages. Pausing keeps
// the balance untouched but makes the package non-bookable — every booking
// guard filters `status === "active"`, so a `paused` package is silently
// excluded until resumed. Reversible: resume flips it straight back to
// `active`. Scoped to the caller's teacherId so a teacher can only touch
// their own roster. Emits no events, so nothing is sent to the student.
export async function togglePackagePauseAction(
  _prev: PackagePauseState,
  formData: FormData,
): Promise<PackagePauseState> {
  const teacher = await requireOnboardedTeacher();
  const t = createT(await getPreferredLocale());
  const parsed = schema.safeParse({
    packageId: formData.get("packageId"),
    intent: formData.get("intent"),
  });
  if (!parsed.success) {
    return { error: t("web.action.invalidRequest") };
  }

  const pkg = await prisma.package.findFirst({
    where: { id: parsed.data.packageId, teacherId: teacher.id },
    select: { id: true, status: true, studentId: true },
  });
  if (!pkg) return { error: t("web.action.packageNotFound") };

  const pausing = parsed.data.intent === "pause";
  const from = pausing ? "active" : "paused";
  const wrongState = {
    error: pausing
      ? t("web.action.packages.onlyActivePause")
      : t("web.action.packages.onlyPausedResume"),
  };
  if (pkg.status !== from) return wrongState;

  // The write is conditioned on the status just checked (#87). applyRefund
  // sets `refunded` in its own transaction; if that lands between the read
  // above and this write, an unconditioned update would put `paused` over
  // `refunded`, and a later resume would make a refunded package bookable
  // again. A status that moved in between is answered the way a stale tab
  // is: the package is no longer in the state this action acts on.
  const { count } = await prisma.package.updateMany({
    where: { id: pkg.id, teacherId: teacher.id, status: from },
    data: { status: pausing ? "paused" : "active" },
  });
  if (count === 0) return wrongState;

  revalidateAfterAction(`/dashboard/students/${pkg.studentId}`);
  return { ok: true };
}
