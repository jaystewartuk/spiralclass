"use server";

import { revalidatePath } from "next/cache";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { setStudentNotificationsEnabledAsTeacher } from "@/lib/students/notification-toggle";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationPrefs,
  type NotificationChannel,
} from "@/lib/notifications/preferences";

export type PrefsActionState = { ok?: boolean; error?: string } | undefined;
export type NotificationsToggleFormState = { ok?: string; error?: string } | undefined;

// Saves a student's notification preferences (which categories) and channel
// opt-ins (email / push). Unchecked checkboxes are absent from FormData,
// so a category/channel is "on" iff its field is present. Every category is
// always rendered, so absence reliably means off.
//
// Scope (see lib/students/identity.ts): category prefs and the email/push
// opt-ins describe the MAILBOX, and this screen is where the inbox owner
// manages them — so they apply across the whole identity set (same-email
// sibling rows under other teachers).
export async function saveNotificationPrefsAction(
  _prev: PrefsActionState,
  formData: FormData,
): Promise<PrefsActionState> {
  const student = await requireStudent();

  const prefs: NotificationPrefs = {};
  for (const c of NOTIFICATION_CATEGORIES) {
    prefs[c] = formData.get(c) != null;
  }

  // Per-category channel prefs are submitted as JSON in a hidden field
  // "channelPrefs" to keep the form encoding simple.
  const channelPrefsRaw = formData.get("channelPrefs");
  if (channelPrefsRaw && typeof channelPrefsRaw === "string") {
    try {
      const parsed = JSON.parse(channelPrefsRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const cp: Partial<Record<string, NotificationChannel[]>> = {};
        for (const c of NOTIFICATION_CATEGORIES) {
          const arr = (parsed as Record<string, unknown>)[c];
          if (Array.isArray(arr)) {
            const valid = arr.filter((ch): ch is NotificationChannel =>
              (NOTIFICATION_CHANNELS as readonly string[]).includes(String(ch)),
            );
            if (valid.length > 0) cp[c] = valid;
          }
        }
        if (Object.keys(cp).length > 0) prefs.channelPrefs = cp;
      }
    } catch {
      // Malformed JSON — ignore, keep no channelPrefs.
    }
  }

  const emailOptIn = formData.get("emailOptIn") != null;
  const pushOptIn = formData.get("pushOptIn") != null;

  const identityIds = await studentIdentityIds(student);

  // Category prefs and email/push opt-in are mailbox-wide — they follow
  // the inbox owner, not a specific teacher–student link.
  await prisma.student.updateMany({
    where: { id: { in: identityIds } },
    data: { notificationPrefs: prefs as object, emailOptIn, pushOptIn },
  });

  revalidatePath("/my-classes/account");
  return { ok: true };
}

// Teacher-only: flips a roster-imported (never-signed-in) student from the
// CSV-import silence to live notifications, or back — see
// lib/students/notification-toggle.ts. Lets the teacher control the moment
// an import actually starts messaging someone.
export async function setStudentNotificationsAsTeacherAction(
  _prev: NotificationsToggleFormState,
  formData: FormData,
): Promise<NotificationsToggleFormState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const studentId = String(formData.get("studentId") ?? "");
  const enabled = formData.get("enabled") === "true";

  const result = await setStudentNotificationsEnabledAsTeacher(
    prisma,
    teacher.id,
    studentId,
    enabled,
  );
  if (!result.ok) {
    return { error: en ? "This student isn't in your list." : "Este alumno no está en tu lista." };
  }

  revalidatePath(`/dashboard/students/${studentId}`);
  return {
    ok: enabled
      ? en
        ? "Notifications enabled."
        : "Notificaciones activadas."
      : en
        ? "Notifications paused."
        : "Notificaciones pausadas.",
  };
}
