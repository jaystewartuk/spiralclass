"use server";

/* eslint-disable @typescript-eslint/no-unused-vars -- server actions
 * called via useActionState must accept (prev, formData); these
 * actions are confirm-only (no fields) so neither parameter is used. */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireTeacher, requireStudent } from "@/lib/auth";
import { auth } from "@/lib/auth/server";
import { getPreferredLocale } from "@/lib/i18n";
import { studentComplianceIds } from "@/lib/students/identity";
import {
  DELETION_GRACE_PERIOD_MS,
  fileStudentDeletionRequests,
  cancelStudentDeletionRequests,
  fileTeacherDeletionRequest,
  cancelTeacherDeletionRequests,
  teacherHasUnusedActivePackages,
  studentsHaveUnusedActivePackages,
} from "@/lib/account-deletion/requests";
import { revalidateAfterAction } from "@/lib/revalidate";

// docs/security.md.
//
// Two-step self-serve deletion: the user clicks "Delete my account",
// we write a row in `account_deletion_requests` with status='pending'
// and `scheduled_for = now + 30 days`. An Inngest cron picks up
// matured rows and anonymizes the subject. The user can cancel from
// the same UI before the 30 days are up.
//
// Tax-record retention: we anonymize the user-identifying columns
// (email, name, phone) but keep Payment rows for the period UK tax law
// requires. The platform entity is UK-established (D-58); the operative
// period is the one the published privacy policy states — six years for
// payment and invoice records (`packages/shared/src/legal/privacy-policy.ts`).
// That file is the single source of truth, so don't restate a number here.
// (This said "CFDI records under Mexican tax law" until 2026-08-25, left over
// from the pre-D-58 Mexican entity; no CFDI is issued.) Override / audit rows
// stay referencing the anonymized teacher_id by FK; the FK target retains the
// row in a "deleted" state.

export type AccountDeletionState = { error?: string; ok?: boolean } | undefined;

// ----- Teacher -----

export async function requestTeacherDeletionAction(
  _prev: AccountDeletionState,
  _formData: FormData,
): Promise<AccountDeletionState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  // Block deletion if the teacher has any active package with classes
  // remaining. Students would lose paid-for sessions; refund the
  // packages first and try again. This keeps us out of consumer-rights
  // disputes that the platform isn't equipped to mediate.
  if (await teacherHasUnusedActivePackages(teacher.id)) {
    return {
      error: en
        ? "You have active packages with classes left. Cancel or refund them before deleting your account."
        : "Tienes paquetes activos con clases pendientes. Cancela o reembólsalos antes de eliminar tu cuenta.",
    };
  }

  await fileTeacherDeletionRequest({
    teacherId: teacher.id,
    email: teacher.email,
    scheduledFor: new Date(Date.now() + DELETION_GRACE_PERIOD_MS),
  });

  revalidateAfterAction("/settings/account");
  return { ok: true };
}

export async function cancelTeacherDeletionAction(
  _prev: AccountDeletionState,
  _formData: FormData,
): Promise<AccountDeletionState> {
  const teacher = await requireTeacher();
  await cancelTeacherDeletionRequests(teacher.id);
  revalidateAfterAction("/settings/account");
  return { ok: true };
}

// ----- Student -----
//
// Identity-set aware: the request and the cancel cover EVERY Student row
// the person's data lives on — the auth-linked row plus same-email
// siblings, INCLUDING moderated rows (studentComplianceIds) — or the
// anonymizer would scrub one row while a sibling keeps name/email/phone.

export async function requestStudentDeletionAction(
  _prev: AccountDeletionState,
  _formData: FormData,
): Promise<AccountDeletionState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  if (!student.email) {
    return {
      error: en
        ? "Your account has no email on file. Contact us."
        : "Tu cuenta no tiene un correo asociado. Contáctanos.",
    };
  }

  const identityIds = await studentComplianceIds(student);

  // Block while any identity row has a package with classes remaining —
  // same consumer-rights reasoning as the teacher path, applied to the
  // whole set since the whole set is what gets anonymized.
  if (await studentsHaveUnusedActivePackages(identityIds)) {
    return {
      error: en
        ? "You still have classes left in a package. Once they're done, you can delete your account."
        : "Aún tienes clases pendientes en un paquete. Cuando termines, podrás eliminar tu cuenta.",
    };
  }

  await fileStudentDeletionRequests({
    studentIds: identityIds,
    email: student.email,
    scheduledFor: new Date(Date.now() + DELETION_GRACE_PERIOD_MS),
  });

  revalidateAfterAction("/my-classes");
  return { ok: true };
}

export async function cancelStudentDeletionAction(
  _prev: AccountDeletionState,
  _formData: FormData,
): Promise<AccountDeletionState> {
  const student = await requireStudent();
  await cancelStudentDeletionRequests(await studentComplianceIds(student));
  revalidateAfterAction("/my-classes");
  return { ok: true };
}

// ----- Sign out after request -----
//
// Optional: callers can chain this after the request action to drop
// the session immediately. Keeps the post-request UI from being a
// teacher-still-signed-in surface; they re-sign-in to cancel.

export async function signOutAfterDeletionRequest() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/?deleted=pending");
}
