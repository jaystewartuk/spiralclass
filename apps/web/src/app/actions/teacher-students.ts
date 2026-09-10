"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { writeOverride } from "@/lib/audit";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { teacherCreateStudentSchema } from "@/lib/validators";
import { normalizeE164 } from "@/lib/phone";
import { gateAddStudent, upgradeNudge } from "@/lib/subscriptions/enforce";
import { defaultNewStudentNotificationPrefs } from "@/lib/notifications/preferences";
import { revalidateAfterAction } from "@/lib/revalidate";

// Silent onboarding (gradual go-live). A teacher can stage a student on her
// roster by hand — replacing the paper notebook — before that student knows
// the app exists. The new (teacher, student) link is created with an
// `onboardingHoldAt` stamp, which the notification dispatcher reads to suppress
// EVERY lifecycle send for the pairing (confirmations, reminders, expiry
// nudges) until the teacher "goes live". Transactional sign-in still works, so
// nothing here can lock a student out. Going live just clears the stamp;
// future notifications then flow normally and the teacher can hand over the
// booking link. Everything is scoped by teacherId (tenant isolation) and audited (teacher overrides).

export type RosterActionState = { error?: string; ok?: string } | undefined;

// ---------- create student (staged, silent) ----------

export async function createStudentAction(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const parsed = teacherCreateStudentSchema(locale).safeParse({
    name: formData.get("name"),
    email: formData.get("email") ?? undefined,
    phone: formData.get("phone"),
    phoneCountry: formData.get("phoneCountry") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();

  // Free-plan active-student cap. Pro is unlimited (gateAddStudent short-
  // circuits). Checked before the duplicate-email lookup so a capped Free
  // teacher gets the upgrade nudge rather than a misleading "invalid data".
  const gate = await gateAddStudent(teacher.id);
  if (!gate.ok) {
    return { error: upgradeNudge("students", locale) };
  }

  const { name, email, phone, phoneCountry } = parsed.data;
  // Falls back to the teacher's own country when the form didn't send one
  // (older client) — a same-market default, always overridable.
  const phoneE164 = phone ? normalizeE164(phone, phoneCountry ?? teacher.country) : null;

  // Soft duplicate guard: if this teacher already has a student on that email,
  // point them at the existing record rather than minting a twin (the roster's
  // merge card handles genuine dupes, but an obvious clash is worth catching
  // up front). Students with no email skip the check — many staged rows won't
  // have one yet.
  if (email) {
    const existing = await prisma.student.findFirst({
      where: { email, teacherStudents: { some: { teacherId: teacher.id } } },
      select: { id: true },
    });
    if (existing) {
      return {
        error: en
          ? "You already have a student with that email."
          : "Ya tienes un alumno con ese correo.",
      };
    }

    // Teacher and Student are mutually exclusive roles per email/auth
    // identity (docs/architecture/multi-teacher-students.md "Mutual
    // exclusivity") — a teacher manually adding her own (or another
    // teacher's) email as a student would mint a roster row no auth
    // identity can ever sign into.
    const teacherConflict = await prisma.teacher.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (teacherConflict) {
      return {
        error: en
          ? "This email belongs to a teacher account and can't be added as a student."
          : "Este correo pertenece a una cuenta de maestra y no se puede agregar como alumno.",
      };
    }
  }

  const now = new Date();
  const studentId = await prisma.$transaction(async (tx) => {
    const student = await tx.student.create({
      data: {
        name,
        email: email ?? null,
        // No explicit locale — the column default applies, as it does on the
        // other two paths that mint a student (lib/students/find-or-create.ts,
        // lib/invitations/manage.ts). This value is not a display default the
        // next render can correct: it is stamped on the row and addresses
        // every lifecycle email that student ever receives, so guessing it
        // here is worse than letting the column answer. The teacher can set it
        // from the contact card.
        phoneE164,
        notificationPrefs: defaultNewStudentNotificationPrefs(),
        teacherStudents: {
          // Staged silently: hold notifications until the teacher goes live.
          create: { teacherId: teacher.id, onboardingHoldAt: now },
        },
      },
      select: { id: true },
    });
    await writeOverride({
      tx,
      teacherId: teacher.id,
      targetType: "student",
      targetId: student.id,
      action: "create_student",
      reason: en
        ? "Student added to the roster (silent onboarding)."
        : "Alumno agregada al listado (alta silenciosa).",
      before: null,
      after: { onboardingHoldAt: now.toISOString() },
      actor: null,
    });
    return student.id;
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "create_student",
      targetType: "student",
      targetId: studentId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction("/dashboard/students");
  redirect(`/dashboard/students/${studentId}`);
}

// ---------- go live ----------

const goLiveSchema = z.object({ studentId: z.string().uuid() });

export async function setStudentLiveAction(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = goLiveSchema.safeParse({ studentId: formData.get("studentId") });
  if (!parsed.success) {
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  const teacher = await requireOnboardedTeacher();
  const link = await prisma.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId: teacher.id, studentId: parsed.data.studentId },
    },
    select: { onboardingHoldAt: true },
  });
  if (!link) {
    return { error: en ? "This student isn't in your list." : "Este alumno no está en tu lista." };
  }
  if (!link.onboardingHoldAt) {
    return { error: en ? "This student is already live." : "Este alumno ya está activo." };
  }
  const heldSince = link.onboardingHoldAt;

  await prisma.$transaction(async (tx) => {
    await tx.teacherStudent.update({
      where: {
        teacherId_studentId: { teacherId: teacher.id, studentId: parsed.data.studentId },
      },
      data: { onboardingHoldAt: null },
    });
    await writeOverride({
      tx,
      teacherId: teacher.id,
      targetType: "student",
      targetId: parsed.data.studentId,
      action: "go_live",
      reason: en
        ? "Student went live — notifications now flow."
        : "Alumno activada — ahora recibe notificaciones.",
      before: { onboardingHoldAt: heldSince.toISOString() },
      after: { onboardingHoldAt: null },
      actor: null,
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "go_live",
      targetType: "student",
      targetId: parsed.data.studentId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${parsed.data.studentId}`);
  return {
    ok: en
      ? "Student is live. They'll receive notifications from now on."
      : "Alumno activada. A partir de ahora recibirá notificaciones.",
  };
}
