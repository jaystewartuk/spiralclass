import {
  NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  TEACHER_NOTIFICATION_CHANNELS,
} from "@spiralclass/shared";
import type {
  NotificationCategory,
  TeacherNotificationCategory,
  NotificationChannel,
  TeacherNotificationChannel,
} from "@spiralclass/shared";
import type { TemplateName } from "./templates";

// Student notification preferences. The "which notifications" layer that sits
// in front of the channel cascade (push → whatsapp → email). Stored on
// Student.notificationPrefs as a partial JSON map of category → on/off; null
// or a missing key means the product default (on). Channel choice ("how") is
// the existing emailOptIn / pushOptIn / device-token machinery.
//
// Transactional templates (sign-in) are NEVER gated by this — disabling
// notifications must never lock a student out of their account.

// Category arrays and types live in @spiralclass/shared so any consumer can
// import them without duplicating. Re-export from here so existing imports
// within the web app continue to resolve through this module.
export {
  NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  TEACHER_NOTIFICATION_CHANNELS,
};
export type {
  NotificationCategory,
  TeacherNotificationCategory,
  NotificationChannel,
  TeacherNotificationChannel,
};

// Billing-critical subscription templates: a lapsing/charged-plan notice the
// teacher must always receive. These are deliberately NOT placed in the
// suppressible "subscription" category, so that a future teacher-preferences
// gate (which will silence whatever `teacherTemplateCategory` returns) can
// never mute a payment-failed/succeeded or cancellation notice. Mirrors how
// `isTransactionalTemplate` keeps access/security mail un-gateable.
const BILLING_CRITICAL_SUBSCRIPTION_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  "subscription_payment_failed",
  "subscription_payment_succeeded",
  "subscription_canceled",
]);

export function isBillingCriticalTemplate(t: TemplateName): boolean {
  return BILLING_CRITICAL_SUBSCRIPTION_TEMPLATES.has(t);
}

// Maps a teacher-recipient template to its (suppressible) teacher category, or
// null for templates that must never be gated — the operational money-of-record
// and security alerts (Wise/Stripe/refund/payment/account-disabled) AND the
// billing-critical subscription notices above.
export function teacherTemplateCategory(t: TemplateName): TeacherNotificationCategory | null {
  // Billing-critical notices are non-suppressible: they have no gateable
  // category even though they're subscription-related.
  if (isBillingCriticalTemplate(t)) return null;
  switch (t) {
    // Pre-class reminders about the teacher's own upcoming classes.
    case "reminder_24h_teacher":
    case "reminder_1h_teacher":
    case "reminder_15m_teacher":
      return "class_reminders";
    // Booking lifecycle on the teacher's calendar.
    case "booking_created_teacher":
    case "cancel_lt24h_teacher":
    case "cancel_gte24h_teacher":
    case "reschedule_confirm_teacher":
      return "class_activity";
    // Post-class / package progress signals.
    case "lesson_insights_review_teacher":
    case "package_consumed_teacher":
    // A student handing in homework is a study-progress signal.
    case "homework_submitted_teacher":
      return "student_progress";
    // Soft/marketing subscription touches that a teacher could reasonably
    // mute without risking a silent lapse.
    case "subscription_trial_ending":
    case "subscription_founding_price_locked":
      return "subscription";
    // Promotional growth reminders — always suppressible.
    case "facebook_groups_nudge_teacher":
    case "student_acquisition_plan_teacher":
      return "growth";
    // Student chat messages — suppressible (teacher may mute during sessions).
    case "chat_message_teacher":
      return "messages";
    // Everything else (payment received/pending, Wise, Stripe, refunds,
    // account disabled, magic-link, billing-critical) is non-suppressible.
    default:
      return null;
  }
}

// Always-send templates: access/security, never configurable.
const TRANSACTIONAL_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>(["magic_link"]);

export function isTransactionalTemplate(t: TemplateName): boolean {
  return TRANSACTIONAL_TEMPLATES.has(t);
}

// Student-side money-of-record templates: mirrors
// BILLING_CRITICAL_SUBSCRIPTION_TEMPLATES above — a receipt, a failed-payment
// notice, or a class-deduction notice must never be fully silenceable, on any
// channel. These deliberately have no gateable category. (Originally
// `payment_received`/`payment_failed_student`/`refund_issued_student`/
// `wise_marked_sent_student` lived in a suppressible "payment_updates"
// category despite the settings-page footer promising receipts are always
// sent — that promise is now actually true. `cancel_lt24h`/`no_show_student`
// moved out of "booking_updates" for the same reason: a student could
// otherwise silence every notice that a class was deducted from their
// package.)
const STUDENT_MONEY_OF_RECORD_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  "payment_received",
  "payment_failed_student",
  "refund_issued_student",
  // A lost chargeback takes the student's remaining classes away. That is a
  // deduction notice about her own money and her own credits, exactly like
  // cancel_lt24h below, so it belongs here rather than in a category she can
  // switch off.
  "dispute_lost_student",
  "wise_marked_sent_student",
  "cancel_lt24h",
  "no_show_student",
]);

export function isStudentMoneyOfRecordTemplate(t: TemplateName): boolean {
  return STUDENT_MONEY_OF_RECORD_TEMPLATES.has(t);
}

// Maps a STUDENT-recipient lifecycle template to its preference category.
// Returns null for transactional templates, money-of-record templates, and
// all teacher-recipient templates (those aren't gated by student prefs). A
// student lifecycle template that returns null would silently bypass prefs —
// the `every student template is categorized` test guards against that.
export function templateCategory(t: TemplateName): NotificationCategory | null {
  if (isStudentMoneyOfRecordTemplate(t)) return null;
  switch (t) {
    case "reminder_24h":
    case "reminder_1h":
    case "reminder_15m":
      return "class_reminders";
    case "booking_confirmation":
    case "cancel_gte24h_with_reschedule":
    case "teacher_cancel":
    case "reschedule_confirm":
      return "booking_updates";
    case "materials_send":
    // Account-level material assignment rides the same "study materials"
    // category as class materials — both are "share me study materials" sends.
    case "library_material_assigned":
    // Homework assigned rides the same category — it's materially "new class
    // content for you", same as the two cases above. Feedback on a submitted
    // attempt is the same homework lifecycle, so it rides the same category
    // rather than introducing a dedicated "progress" bucket for one template.
    case "homework_assigned_student":
    case "homework_feedback_available_student":
    // Due-soon/overdue nudges are the same homework lifecycle, same category —
    // a student who muted "new homework" copy shouldn't still get reminded
    // about it under a different bucket.
    case "homework_due_soon_student":
    case "homework_overdue_student":
      return "class_materials";
    case "package_expiry_nudge":
    // The consumed-package renewal nudge rides the same category: both are
    // "talk to me about my package's lifecycle" sends, and adding a category
    // would re-prompt every student who already configured preferences.
    case "package_consumed_student":
      return "expiry_reminders";
    case "chat_message":
      return "messages";
    default:
      return null;
  }
}

// Stored shape: partial map; absent key = default (on).
// channelPrefs maps each category to the subset of channels that the cascade
// will try for that category (in the standard push → whatsapp → email order,
// but only within the listed channels). Absent key = all channels (full
// cascade). Non-suppressible templates ignore channelPrefs entirely.
export type NotificationPrefs = Partial<Record<NotificationCategory, boolean>> & {
  channelPrefs?: Partial<Record<NotificationCategory, NotificationChannel[]>>;
};
// Teacher analogue — same shape, teacher category keys and teacher channels.
export type TeacherNotificationPrefs = Partial<Record<TeacherNotificationCategory, boolean>> & {
  channelPrefs?: Partial<Record<TeacherNotificationCategory, TeacherNotificationChannel[]>>;
};

// A category is enabled unless the recipient explicitly turned it off. Null
// prefs (funnel students / teachers who've never touched the toggles) →
// everything on. Category is typed as a bare string so the one gate serves
// both the student and teacher prefs maps.
export function isCategoryEnabled(
  prefs: Partial<Record<string, unknown>> | null | undefined,
  category: string,
): boolean {
  if (!prefs) return true;
  const val = prefs[category];
  return val !== false;
}

// Returns the ordered channel list for a category, or null when the prefs
// have no per-category override (meaning "use all channels" / full cascade).
// The caller passes either NotificationPrefs or TeacherNotificationPrefs —
// the shape is the same at runtime (same `channelPrefs` key).
export function getAllowedChannels(
  prefs: { channelPrefs?: Partial<Record<string, string[]>> } | null | undefined,
  category: string,
): NotificationChannel[] | null {
  const raw = prefs?.channelPrefs?.[category];
  if (!raw || raw.length === 0) return null;
  // Validate against the known channel set, drop unknown strings.
  const valid = raw.filter((c): c is NotificationChannel =>
    (NOTIFICATION_CHANNELS as readonly string[]).includes(c),
  );
  return valid.length > 0 ? valid : null;
}

// Full all-off map — used to silence CSV-imported students at import time
// (and as the migration backfill value for the existing roster).
export function allDisabledPrefs(): Record<NotificationCategory, boolean> {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, false])) as Record<
    NotificationCategory,
    boolean
  >;
}

// Default prefs stamped on every newly-created Student row (self-serve
// checkout, teacher invite, teacher-added roster entry — see the four
// student.create call sites). PostHog showed new students hitting
// /settings/notifications repeatedly right after signup — a sign the
// previous behavior (leaving notificationPrefs null, which isCategoryEnabled
// reads as "everything on") was too noisy on day one. Trims the default to
// what a student needs to not miss a class or a teacher message; the
// lower-urgency nudge categories start off and are one tap away to enable.
export function defaultNewStudentNotificationPrefs(): Record<NotificationCategory, boolean> {
  return {
    class_reminders: true,
    booking_updates: true,
    messages: true,
    class_materials: false,
    expiry_reminders: false,
  };
}

// True only for the exact all-off shape above — the CSV-import snapshot. A
// student who has touched their own settings (partial prefs) or never been
// imported (null) reads as already live. Backs the teacher's one-tap
// "launch this student" control, so an imported roster stays silent until
// the teacher is ready — without requiring the student to sign in first.
export function isNotificationsFullyDisabled(
  prefs: Partial<Record<string, unknown>> | null | undefined,
): boolean {
  if (!prefs) return false;
  return NOTIFICATION_CATEGORIES.every((c) => prefs[c] === false);
}

// Normalize arbitrary JSON against an explicit category allow-list — only
// known category keys with boolean values survive. The `channelPrefs` nested
// map is also preserved: only known categories and known channel strings survive.
function coercePrefs<C extends string, Ch extends string>(
  value: unknown,
  categories: readonly C[],
  channels: readonly Ch[],
): Partial<Record<C, boolean>> & { channelPrefs?: Partial<Record<C, Ch[]>> } {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<C, boolean>> & { channelPrefs?: Partial<Record<C, Ch[]>> } = {};

  for (const c of categories) {
    const v = raw[c];
    if (typeof v === "boolean") (out as Partial<Record<C, boolean>>)[c] = v;
  }

  const rawChannelPrefs = raw["channelPrefs"];
  if (rawChannelPrefs && typeof rawChannelPrefs === "object" && !Array.isArray(rawChannelPrefs)) {
    const cp = rawChannelPrefs as Record<string, unknown>;
    const coercedCp: Partial<Record<C, Ch[]>> = {};
    let hasCp = false;
    for (const c of categories) {
      const arr = cp[c];
      if (Array.isArray(arr)) {
        const valid = arr.filter(
          (x): x is Ch => typeof x === "string" && (channels as readonly string[]).includes(x),
        );
        if (valid.length > 0) {
          coercedCp[c] = valid;
          hasCp = true;
        }
      }
    }
    if (hasCp) out.channelPrefs = coercedCp;
  }

  return out;
}

// Normalize the student prefs column / form post — unknown keys dropped.
export function coerceNotificationPrefs(value: unknown): NotificationPrefs {
  return coercePrefs(value, NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS);
}

// Normalize the teacher prefs column / form post — unknown keys dropped.
export function coerceTeacherNotificationPrefs(value: unknown): TeacherNotificationPrefs {
  return coercePrefs(value, TEACHER_NOTIFICATION_CATEGORIES, TEACHER_NOTIFICATION_CHANNELS);
}
