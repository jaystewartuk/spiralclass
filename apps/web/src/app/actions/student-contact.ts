"use server";

import { z } from "zod";
import { createT, isCaptionLanguage, type TFunction } from "@spiralclass/shared";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { studentContactSchema, teacherEditStudentContactSchema } from "@/lib/validators";
import { applyStudentContactUpdate, type ContactUpdateError } from "@/lib/students/contact";
import { requestStudentEmailChange, verifyStudentEmailChange } from "@/lib/students/email-change";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";

export type ContactFormState = { ok?: string; error?: string } | undefined;
export type EmailChangeFormState =
  { pendingEmail?: string; ok?: string; error?: string } | undefined;

function contactErrorMessage(error: ContactUpdateError, t: TFunction): string {
  switch (error) {
    case "not-found":
      return t("web.action.contact.notInList");
    case "email-locked":
      return t("web.action.contact.emailLocked");
    case "email-taken":
      return t("web.action.contact.emailTaken");
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
  const t = createT(locale);

  const parsed = studentContactSchema(locale).safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    phoneCountry: formData.get("phoneCountry") ?? undefined,
    timezone: formData.get("timezone") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? t("web.action.invalidData"),
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
  if (!result.ok) return { error: contactErrorMessage(result.error, t) };
  // Drain student_contact_updated before the action returns / lambda freezes.
  await flushAnalytics();

  revalidateAfterAction("/my-classes", "layout");
  return { ok: t("web.action.contact.saved") };
}

// Teacher roster fix: name, email (only while the student has never signed
// in) and phone number from /dashboard/students/[studentId].
export async function updateStudentContactAsTeacherAction(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = createT(locale);

  const parsed = teacherEditStudentContactSchema(locale).safeParse({
    studentId: formData.get("studentId"),
    name: formData.get("name"),
    email: formData.get("email") ?? undefined,
    phone: formData.get("phone"),
    phoneCountry: formData.get("phoneCountry") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? t("web.action.invalidData"),
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
  if (!result.ok) return { error: contactErrorMessage(result.error, t) };
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${parsed.data.studentId}`);
  return { ok: t("web.action.contact.teacherSaved") };
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
  const t = createT(locale);

  // requireStudent doesn't gate moderation; don't hand a moderated account
  // an identity-moving tool (mirrors the checkout / magic-link refusals).
  if (student.disabledAt) {
    return { error: t("web.action.accountDisabled") };
  }

  const parsed = z
    .string()
    .trim()
    .email(t("email.invalid"))
    .max(254)
    .safeParse(formData.get("newEmail"));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? t("email.invalid") };
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
      error: t("web.action.contact.tooMany"),
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
        return { error: t("web.action.contact.sameEmail") };
      case "send-failed":
        return {
          error: t("web.action.contact.sendFailed"),
        };
      // "unavailable" covers addresses already in use — kept generic on
      // purpose so the form doesn't confirm which emails have accounts.
      case "not-linked":
      case "unavailable":
        return {
          error: t("web.action.contact.emailUnusable"),
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
  const t = createT(locale);

  if (student.disabledAt) {
    return { error: t("web.action.accountDisabled") };
  }
  if (!student.authUserId) {
    return { error: t("web.action.contact.noAccount") };
  }

  const newEmail = formData.get("newEmail");
  const code = formData.get("code");
  if (typeof newEmail !== "string" || typeof code !== "string" || !newEmail || !code) {
    return { error: t("web.action.missingEmailOrCode") };
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
          ? t("web.action.invalidOrExpiredCode")
          : t("web.action.contact.confirmFailed"),
    };
  }

  revalidateAfterAction("/my-classes/account");
  const ok = result.googleDisconnected
    ? t("web.action.contact.emailUpdatedGoogleDisconnected")
    : t("web.action.contact.emailUpdated");
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
  const t = createT(locale);

  const nativeLanguage = (formData.get("nativeLanguage") ?? "").toString().trim();
  if (!isCaptionLanguage(nativeLanguage)) {
    return { error: t("web.action.contact.unknownLanguage") };
  }

  await prisma.student.update({
    where: { id: student.id },
    data: { nativeLanguage },
  });

  revalidateAfterAction("/my-classes/account");
  return { ok: t("web.action.contact.languageSaved") };
}
