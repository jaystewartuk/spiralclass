"use server";

import { z } from "zod";
import { requireTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale } from "@/lib/i18n";
import { rateLimit } from "@/lib/rate-limit";
import { teacherContactSchema } from "@/lib/validators";
import { normalizeE164 } from "@/lib/phone";
import { requestTeacherEmailChange, verifyTeacherEmailChange } from "@/lib/teachers/email-change";
import {
  TEACHER_NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CHANNELS,
  type TeacherNotificationPrefs,
  type TeacherNotificationChannel,
} from "@/lib/notifications/preferences";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import {
  COUNTRY_CODES,
  DEFAULT_DASHBOARD_TILE_KEYS,
  resolveDashboardTiles,
  type DashboardTilePref,
  usesEnglishCopy,
} from "@spiralclass/shared";
import { revalidateAfterAction } from "@/lib/revalidate";

export type TeacherContactFormState = { ok?: string; error?: string } | undefined;
export type TeacherCountryFormState = { ok?: string; error?: string } | undefined;
export type TeacherEmailChangeFormState =
  { pendingEmail?: string; ok?: string; error?: string } | undefined;
export type TeacherPrefsActionState = { ok?: boolean; error?: string } | undefined;

// Teacher self-service: name, phone number and time zone on the teacher
// account page. Email lives in its own card (verified email-change flow). The
// teacher twin of updateMyContactInfoAction.
export async function updateMyTeacherContactAction(
  _prev: TeacherContactFormState,
  formData: FormData,
): Promise<TeacherContactFormState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const parsed = teacherContactSchema(locale).safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    timezone: formData.get("timezone") ?? undefined,
    phoneCountry: formData.get("phoneCountry") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  // An empty field clears the number. The phone's country is picked
  // independently of the teacher's payout country (her Stripe Connect
  // country, set via the separate Country card/action on this page) — a
  // phone number can carry a different country's calling code than where
  // she's based for payouts, so the two must never be locked together.
  const phoneE164 = parsed.data.phone
    ? normalizeE164(parsed.data.phone, parsed.data.phoneCountry ?? teacher.country)
    : null;
  const name = parsed.data.name;
  const timezone = parsed.data.timezone ?? teacher.timezone;

  const fields: string[] = [];
  if (name !== teacher.name) fields.push("name");
  if (phoneE164 !== teacher.phoneE164) fields.push("phone");
  if (timezone !== teacher.timezone) fields.push("timezone");

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { name, phoneE164, timezone },
  });

  if (fields.length > 0) {
    trackServerEvent({
      name: "teacher_contact_updated",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, fields },
    });
    await flushAnalytics();
  }

  // D-53: availability rules carry the zone they were written in and are NOT
  // rewritten when the teacher changes their zone (so existing booked instants
  // can't desync). Make that explicit instead of silent: if the teacher just
  // moved their zone and still has hours frozen in a different one, tell them to
  // review — re-saving Working hours restamps them to the new zone.
  let staleZone: string | null = null;
  if (timezone !== teacher.timezone) {
    const stale = await prisma.availabilityRule.findFirst({
      where: { teacherId: teacher.id, timezone: { not: timezone } },
      select: { timezone: true },
    });
    staleZone = stale?.timezone ?? null;
  }

  revalidateAfterAction("/settings/account");
  const saved = en ? "Details saved." : "Datos guardados.";
  if (staleZone) {
    return {
      ok: en
        ? `${saved} Heads up: your working hours are still set in ${staleZone}. Open Working hours to review them if you've moved.`
        : `${saved} Aviso: tu horario de trabajo sigue en ${staleZone}. Abre Horario de trabajo para revisarlo si te mudaste.`,
    };
  }
  return { ok: saved };
}

// Teacher self-service: change of country (drives Stripe Connect account
// creation + future tax/currency). Frozen once a Stripe account exists — Stripe
// fixes a connected account's country at creation, so we refuse the change
// rather than let the DB desync from the connected account. Kept a separate
// action (not folded into contact) so the guard lives in one place.
export async function updateMyTeacherCountryAction(
  _prev: TeacherCountryFormState,
  formData: FormData,
): Promise<TeacherCountryFormState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  if (teacher.stripeAccountId) {
    return {
      error: en
        ? "Disconnect Stripe before changing your country — your payout account is tied to it."
        : "Desconecta Stripe antes de cambiar tu país — tu cuenta de cobro está ligada a él.",
    };
  }

  const parsed = z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => (COUNTRY_CODES as readonly string[]).includes(v))
    .safeParse(formData.get("country"));
  if (!parsed.success) {
    return { error: en ? "Invalid country." : "País inválido." };
  }

  if (parsed.data !== teacher.country) {
    await prisma.teacher.update({
      where: { id: teacher.id },
      data: { country: parsed.data },
    });
    trackServerEvent({
      name: "teacher_contact_updated",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, fields: ["country"] },
    });
    await flushAnalytics();
  }

  revalidateAfterAction("/settings/account");
  return { ok: en ? "Country saved." : "País guardado." };
}

// Step 1 of the verified teacher email change: the signed-in teacher names a
// new address and we send it a 6-digit code (better-auth changeEmail). See
// verifyTeacherEmailChangeAction below and lib/teachers/email-change.ts.
// Mirrors requestEmailChangeAction (student).
export async function requestTeacherEmailChangeAction(
  _prev: TeacherEmailChangeFormState,
  formData: FormData,
): Promise<TeacherEmailChangeFormState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  // requireTeacher already redirects disabled teachers, but guard explicitly:
  // never hand a moderated account an identity-moving tool.
  if (teacher.disabledAt) {
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

  // Keyed on the teacher (the endpoint is authenticated), not the IP: each
  // request emails an arbitrary address, so the budget belongs to the account.
  const rl = await rateLimit(teacher.id, {
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

  const result = await requestTeacherEmailChange({
    teacher: { id: teacher.id, email: teacher.email },
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

// Step 2 of the verified email change: the teacher types the code we sent to
// the new address. On success this both flips the sign-in identity and syncs
// the Teacher row in one pass (verifyTeacherEmailChange).
export async function verifyTeacherEmailChangeAction(
  _prev: TeacherEmailChangeFormState,
  formData: FormData,
): Promise<TeacherEmailChangeFormState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  if (teacher.disabledAt) {
    return { error: en ? "This account is disabled." : "Esta cuenta está deshabilitada." };
  }

  const newEmail = formData.get("newEmail");
  const code = formData.get("code");
  if (typeof newEmail !== "string" || typeof code !== "string" || !newEmail || !code) {
    return { error: en ? "Missing email or code." : "Falta correo o código." };
  }

  const result = await verifyTeacherEmailChange({
    teacherId: teacher.id,
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

  revalidateAfterAction("/settings/account");
  const ok = result.googleDisconnected
    ? en
      ? "Email updated. Your Google account was disconnected for security — reconnect it below with your new Google account if you'd like to keep using Google Sign-In."
      : "Correo actualizado. Tu cuenta de Google se desconectó por seguridad — puedes volver a conectarla abajo con tu nueva cuenta de Google si quieres seguir usando el inicio de sesión con Google."
    : en
      ? "Email updated."
      : "Correo actualizado.";
  return { ok };
}

// Saves a teacher's notification preferences (which categories). Unchecked
// checkboxes are absent from FormData, so a category is "on" iff its field is
// present. Every category is always rendered, so absence reliably means off.
// Channel choice is not configurable for teachers: their notices go to email
// (the channel of record for operational/billing mail) and push; the category
// toggles are the lever, and money/security notices stay non-suppressible.
export async function saveTeacherNotificationPrefsAction(
  _prev: TeacherPrefsActionState,
  formData: FormData,
): Promise<TeacherPrefsActionState> {
  const teacher = await requireTeacher();

  const prefs: TeacherNotificationPrefs = {};
  for (const c of TEACHER_NOTIFICATION_CATEGORIES) {
    prefs[c] = formData.get(c) != null;
  }

  // Per-category channel prefs (push | email) submitted as JSON.
  const channelPrefsRaw = formData.get("channelPrefs");
  if (channelPrefsRaw && typeof channelPrefsRaw === "string") {
    try {
      const parsed = JSON.parse(channelPrefsRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const cp: Partial<Record<string, TeacherNotificationChannel[]>> = {};
        for (const c of TEACHER_NOTIFICATION_CATEGORIES) {
          const arr = (parsed as Record<string, unknown>)[c];
          if (Array.isArray(arr)) {
            const valid = arr.filter((ch): ch is TeacherNotificationChannel =>
              (TEACHER_NOTIFICATION_CHANNELS as readonly string[]).includes(String(ch)),
            );
            if (valid.length > 0) cp[c] = valid;
          }
        }
        if (Object.keys(cp).length > 0) prefs.channelPrefs = cp;
      }
    } catch {
      // Malformed JSON — ignore.
    }
  }

  const emailOptIn = formData.get("emailOptIn") != null;
  const pushOptIn = formData.get("pushOptIn") != null;

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { notificationPrefs: prefs as object, emailOptIn, pushOptIn },
  });

  revalidateAfterAction("/settings/notifications");
  return { ok: true };
}

// Saves the teacher's customizable "Day to day" dashboard tile order/
// visibility. The client sends the full ordered list it rendered (one
// {key, hidden} entry per tile); resolveDashboardTiles() re-validates it
// against the canonical NavKey set server-side so a stale/tampered payload
// can't smuggle in an unknown key.
export async function saveDashboardTilesAction(
  _prev: TeacherPrefsActionState,
  formData: FormData,
): Promise<TeacherPrefsActionState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const raw = formData.get("tiles");
  if (typeof raw !== "string") {
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }
  if (!Array.isArray(parsed)) {
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  const validKeys = new Set(DEFAULT_DASHBOARD_TILE_KEYS);
  const tiles: DashboardTilePref[] = parsed.filter(
    (t): t is DashboardTilePref =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as DashboardTilePref).key === "string" &&
      validKeys.has((t as DashboardTilePref).key),
  );

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { dashboardTileOrder: resolveDashboardTiles(tiles) as object },
  });

  revalidateAfterAction("/dashboard/customize");
  return { ok: true };
}
