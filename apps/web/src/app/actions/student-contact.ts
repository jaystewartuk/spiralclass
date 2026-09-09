"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isCaptionLanguage } from "@spiralclass/shared";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { studentContactSchema, teacherEditStudentContactSchema } from "@/lib/validators";
import { applyStudentContactUpdate, type ContactUpdateError } from "@/lib/students/contact";
import { requestStudentEmailChange, verifyStudentEmailChange } from "@/lib/students/email-change";
import { flushAnalytics } from "@/lib/analytics/posthog";

export type ContactFormState = { ok?: string; error?: string } | undefined;
export type EmailChangeFormState =
  { pendingEmail?: string; ok?: string; error?: string } | undefined;

function contactErrorMessage(error: ContactUpdateError, en: boolean): string {
  switch (error) {
    case "not-found":
      return en ? "This student isn't in your list." : "Este alumno no está en tu lista.";
    case "email-locked":
      return en
        ? "This student already signs in with their email, so it can only be changed from their account."
        : "Este alumno ya inicia sesión con su correo, así que solo puede cambiarse desde su cuenta.";
    case "email-taken":
      return en
        ? "Another of your students already uses that email."
        : "Otro de tus alumnos ya usa ese correo.";
  }
}

// Student self-service: name, phone number and timezone on
// /my-classes/account. Email is read-only here until the verified
// email-change flow ships — see the form copy.
export async function updateMyContactInfoAction(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const parsed = studentContactSchema(locale).safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    phoneCountry: formData.get("phoneCountry") ?? undefined,
    timezone: formData.get("timezone") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const result = await applyStudentContactUpdate({
    studentId: student.id,
    actor: { type: "student" },
    patch: {
      name: parsed.data.name,
      // An empty field clears the number.
      phoneE164: parsed.data.phone ?? null,
      phoneCountry: parsed.data.phoneCountry,
      ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
    },
  });
  if (!result.ok) return { error: contactErrorMessage(result.error, en) };
  // Drain student_contact_updated before the action returns / lambda freezes.
  await flushAnalytics();

  revalidatePath("/my-classes", "layout");
  return { ok: en ? "Details saved." : "Datos guardados." };
}

// Teacher roster fix: name, email (only while the student has never signed
// in) and phone number from /dashboard/students/[studentId].
export async function updateStudentContactAsTeacherAction(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const parsed = teacherEditStudentContactSchema(locale).safeParse({
    studentId: formData.get("studentId"),
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

  const result = await applyStudentContactUpdate({
    studentId: parsed.data.studentId,
    actor: { type: "teacher", teacherId: teacher.id },
    patch: {
      name: parsed.data.name,
      // Empty email means "leave as is" — clearing a provisioned student's
      // email would strand their future magic-link sign-in.
      ...(parsed.data.email ? { email: parsed.data.email } : {}),
      phoneE164: parsed.data.phone ?? null,
      // Falls back to the teacher's own country when the form didn't send
      // one (older client) — a same-market default, always overridable.
      phoneCountry: parsed.data.phoneCountry ?? teacher.country,
    },
  });
  if (!result.ok) return { error: contactErrorMessage(result.error, en) };
  await flushAnalytics();

  revalidatePath(`/dashboard/students/${parsed.data.studentId}`);
  revalidatePath("/dashboard/students");
  return { ok: en ? "Contact details saved." : "Datos de contacto guardados." };
}

// Step 1 of the verified email change: the signed-in student names a new
// address and we send it a 6-digit code (better-auth changeEmail). See
// verifyEmailChangeAction below and src/lib/students/email-change.ts.
export async function requestEmailChangeAction(
  _prev: EmailChangeFormState,
  formData: FormData,
): Promise<EmailChangeFormState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  // requireStudent doesn't gate moderation; don't hand a moderated account
  // an identity-moving tool (mirrors the checkout / magic-link refusals).
  if (student.disabledAt) {
    return { error: en ? "This account is disabled." : "Esta cuenta está deshabilitada." };
  }

  const parsed = z
    .string()
    .trim()
    .email(en ? "Invalid email" : "Correo inválido")
    .max(254)
    .safeParse(formData.get("newEmail"));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid email" : "Correo inválido") };
  }

  // Keyed on the student (the endpoint is authenticated), not the IP: each
  // request emails an arbitrary address, so the budget belongs to the
  // account doing the sending.
  const rl = await rateLimit(student.id, {
    scope: "email-change",
    limit: 4,
    windowMs: 15 * 60_000,
  });
  if (!rl.ok) {
    return {
      error: en
        ? "Too many attempts. Wait a few minutes and try again."
        : "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.",
    };
  }

  const result = await requestStudentEmailChange({
    student: {
      id: student.id,
      authUserId: student.authUserId,
      email: student.email,
    },
    newEmail: parsed.data,
  });
  if (!result.ok) {
    switch (result.error) {
      case "same-email":
        return { error: en ? "That's already your email." : "Ese ya es tu correo." };
      case "send-failed":
        return {
          error: en
            ? "We couldn't send the confirmation email. Try again."
            : "No pudimos enviar el correo de confirmación. Intenta de nuevo.",
        };
      // "unavailable" covers addresses already in use — kept generic on
      // purpose so the form doesn't confirm which emails have accounts.
      case "not-linked":
      case "unavailable":
        return {
          error: en
            ? "We couldn't use that email. Try another one, or write to us from the Help page."
            : "No pudimos usar ese correo. Intenta con otro o escríbenos desde la página de ayuda.",
        };
    }
  }

  return { pendingEmail: result.pendingEmail };
}

// Step 2 of the verified email change: the student types the code we sent to
// the new address. On success this both flips the sign-in identity and syncs
// every Student row that carried the old address (verifyStudentEmailChange).
export async function verifyEmailChangeAction(
  _prev: EmailChangeFormState,
  formData: FormData,
): Promise<EmailChangeFormState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  if (student.disabledAt) {
    return { error: en ? "This account is disabled." : "Esta cuenta está deshabilitada." };
  }
  if (!student.authUserId) {
    return { error: en ? "No account to verify." : "No hay cuenta que verificar." };
  }

  const newEmail = formData.get("newEmail");
  const code = formData.get("code");
  if (typeof newEmail !== "string" || typeof code !== "string" || !newEmail || !code) {
    return { error: en ? "Missing email or code." : "Falta correo o código." };
  }

  const result = await verifyStudentEmailChange({
    studentAuthUserId: student.authUserId,
    newEmail,
    otp: code.trim(),
  });
  if (!result.ok) {
    return {
      error:
        result.error === "invalid-code"
          ? en
            ? "Invalid or expired code. Request a new one."
            : "Código inválido o expirado. Solicita uno nuevo."
          : en
            ? "We couldn't confirm that email. Try again."
            : "No pudimos confirmar ese correo. Intenta de nuevo.",
    };
  }

  revalidatePath("/my-classes/account");
  const ok = result.googleDisconnected
    ? en
      ? "Email updated. Your Google account was disconnected for security — reconnect it below with your new Google account if you'd like to keep using Google Sign-In."
      : "Correo actualizado. Tu cuenta de Google se desconectó por seguridad — puedes volver a conectarla abajo con tu nueva cuenta de Google si quieres seguir usando el inicio de sesión con Google."
    : en
      ? "Email updated."
      : "Correo actualizado.";
  return { ok };
}

// Live-caption default language (D-27): the student's own language, used as
// the ASR/translation source for their own speech and the target when
// translating the teacher, unless a specific class overrides it. Same shape
// as the teacher's saveTeachingLanguageAction.
export async function saveNativeLanguageAction(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const nativeLanguage = (formData.get("nativeLanguage") ?? "").toString().trim();
  if (!isCaptionLanguage(nativeLanguage)) {
    return { error: en ? "Unknown language." : "Idioma desconocido." };
  }

  await prisma.student.update({
    where: { id: student.id },
    data: { nativeLanguage },
  });

  revalidatePath("/my-classes/account");
  return { ok: en ? "Language saved." : "Idioma guardado." };
}
