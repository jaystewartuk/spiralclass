"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";

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
  const en = (await getPreferredLocale()) === "en";
  const parsed = schema.safeParse({
    packageId: formData.get("packageId"),
    intent: formData.get("intent"),
  });
  if (!parsed.success) {
    return { error: en ? "Invalid request" : "Solicitud inválida" };
  }

  const pkg = await prisma.package.findFirst({
    where: { id: parsed.data.packageId, teacherId: teacher.id },
    select: { id: true, status: true, studentId: true },
  });
  if (!pkg) return { error: en ? "Package not found" : "Paquete no encontrado" };

  if (parsed.data.intent === "pause") {
    if (pkg.status !== "active") {
      return {
        error: en
          ? "Only an active package can be paused"
          : "Solo se puede pausar un paquete activo",
      };
    }
  } else if (pkg.status !== "paused") {
    return {
      error: en
        ? "Only a paused package can be resumed"
        : "Solo se puede reactivar un paquete en pausa",
    };
  }

  await prisma.package.update({
    where: { id: pkg.id },
    data: { status: parsed.data.intent === "pause" ? "paused" : "active" },
  });

  revalidatePath(`/dashboard/students/${pkg.studentId}`);
  return { ok: true };
}
