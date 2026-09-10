import type { TemplateName } from "@/lib/notifications/templates";
import { getT } from "@/lib/i18n";
import type { StringKey } from "@/lib/i18n-translate";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { CATEGORY_LABEL_KEYS } from "@/lib/notifications/category-labels";
import {
  NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CATEGORIES,
  getAllowedChannels,
  isCategoryEnabled,
} from "@/lib/notifications/preferences";

// "What we send and when" reference for students and teachers (UAT: neither
// side could see which notifications to expect). Rows list only notifications
// that are actually wired end-to-end and each row declares the exact template
// names it covers — apps/web/tests/notifications/notification-schedule.test.ts
// asserts every TEMPLATE_NAMES entry appears in exactly one row for its
// audience, so a new/removed producer fails CI here instead of silently
// drifting out of sync with this copy.
//
// TWO THINGS CHANGED HERE, and both were defects rather than taste.
//
// 1. THE COPY LIVED IN THIS FILE, IN TWO LANGUAGES, selected by an `en:
//    boolean` prop the callers computed as `locale === "en"`. French is a
//    registered locale (see packages/shared/src/i18n/locales.ts), so a French
//    teacher read this entire reference IN SPANISH — the one branch a boolean
//    cannot express. Every row's copy is now a catalog key, so the compiler's
//    completeness guard (catalog.ts) is what keeps all three locales honest,
//    the same mechanism the rest of the product uses.
//
// 2. IT WAS ONE FLAT LIST OF UP TO SIXTEEN ROWS, unrelated to the preference
//    switches directly above it on the same page. The reader had no way to
//    answer the only question this list is for — "will this actually reach
//    me?" Rows now declare the preference `group` that gates them, so the
//    reference renders grouped by that category with the recipient's own
//    current state on each group, and everything ungateable under one
//    "Always sent" heading. `group` is verified against the dispatcher's own
//    `templateCategory`/`teacherTemplateCategory` by the test above — the
//    grouping cannot claim a gate the cascade does not apply.

/** The preference category that gates a row, or `always` when nothing does. */
type Group = string;

const ALWAYS: Group = "always";

type Row = {
  key: string;
  templates: readonly TemplateName[];
  /** Preference category id, or ALWAYS for non-suppressible sends. */
  group: Group;
  whatKey: StringKey;
  whenKey: StringKey;
};

const STUDENT_ROWS: readonly Row[] = [
  {
    key: "booking_confirmation",
    templates: ["booking_confirmation"],
    group: "booking_updates",
    whatKey: "web.notificationSchedule.student.bookingConfirmation.what",
    whenKey: "web.notificationSchedule.student.bookingConfirmation.when",
  },
  {
    key: "class_reminders",
    templates: ["reminder_24h", "reminder_1h", "reminder_15m"],
    group: "class_reminders",
    whatKey: "web.notificationSchedule.student.classReminders.what",
    whenKey: "web.notificationSchedule.student.classReminders.when",
  },
  {
    key: "class_materials",
    templates: ["materials_send", "library_material_assigned"],
    group: "class_materials",
    whatKey: "web.notificationSchedule.student.classMaterials.what",
    whenKey: "web.notificationSchedule.student.classMaterials.when",
  },
  {
    key: "homework_assigned",
    templates: ["homework_assigned_student"],
    group: "class_materials",
    whatKey: "web.notificationSchedule.student.homeworkAssigned.what",
    whenKey: "web.notificationSchedule.student.homeworkAssigned.when",
  },
  {
    key: "homework_feedback",
    templates: ["homework_feedback_available_student"],
    group: "class_materials",
    whatKey: "web.notificationSchedule.student.homeworkFeedback.what",
    whenKey: "web.notificationSchedule.student.homeworkFeedback.when",
  },
  {
    key: "homework_reminders",
    templates: ["homework_due_soon_student", "homework_overdue_student"],
    group: "class_materials",
    whatKey: "web.notificationSchedule.student.homeworkReminders.what",
    whenKey: "web.notificationSchedule.student.homeworkReminders.when",
  },
  {
    key: "payments",
    templates: [
      "payment_received",
      "payment_failed_student",
      "refund_issued_student",
      "dispute_lost_student",
      "wise_marked_sent_student",
    ],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.student.payments.what",
    whenKey: "web.notificationSchedule.student.payments.when",
  },
  {
    key: "cancellations_reschedules",
    templates: ["cancel_gte24h_with_reschedule", "teacher_cancel", "reschedule_confirm"],
    group: "booking_updates",
    whatKey: "web.notificationSchedule.student.cancellationsReschedules.what",
    whenKey: "web.notificationSchedule.student.cancellationsReschedules.when",
  },
  {
    key: "late_cancellation",
    templates: ["cancel_lt24h"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.student.lateCancellation.what",
    whenKey: "web.notificationSchedule.student.lateCancellation.when",
  },
  {
    key: "no_show",
    templates: ["no_show_student"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.student.noShow.what",
    whenKey: "web.notificationSchedule.student.noShow.when",
  },
  {
    key: "package_lifecycle",
    templates: ["package_expiry_nudge", "package_consumed_student"],
    group: "expiry_reminders",
    whatKey: "web.notificationSchedule.student.packageLifecycle.what",
    whenKey: "web.notificationSchedule.student.packageLifecycle.when",
  },
  {
    key: "chat_messages",
    templates: ["chat_message"],
    group: "messages",
    whatKey: "web.notificationSchedule.student.chatMessages.what",
    whenKey: "web.notificationSchedule.student.chatMessages.when",
  },
  {
    key: "sign_in_links",
    templates: ["magic_link"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.student.signInLinks.what",
    whenKey: "web.notificationSchedule.student.signInLinks.when",
  },
];

const TEACHER_ROWS: readonly Row[] = [
  {
    key: "class_reminders",
    templates: ["reminder_24h_teacher", "reminder_1h_teacher", "reminder_15m_teacher"],
    group: "class_reminders",
    whatKey: "web.notificationSchedule.teacher.classReminders.what",
    whenKey: "web.notificationSchedule.teacher.classReminders.when",
  },
  {
    key: "new_booking",
    templates: ["booking_created_teacher"],
    group: "class_activity",
    whatKey: "web.notificationSchedule.teacher.newBooking.what",
    whenKey: "web.notificationSchedule.teacher.newBooking.when",
  },
  {
    key: "student_cancellation",
    templates: ["cancel_lt24h_teacher", "cancel_gte24h_teacher"],
    group: "class_activity",
    whatKey: "web.notificationSchedule.teacher.studentCancellation.what",
    whenKey: "web.notificationSchedule.teacher.studentCancellation.when",
  },
  {
    key: "reschedule_confirmed",
    templates: ["reschedule_confirm_teacher"],
    group: "class_activity",
    whatKey: "web.notificationSchedule.teacher.rescheduleConfirmed.what",
    whenKey: "web.notificationSchedule.teacher.rescheduleConfirmed.when",
  },
  {
    key: "homework_submitted",
    templates: ["homework_submitted_teacher"],
    group: "student_progress",
    whatKey: "web.notificationSchedule.teacher.homeworkSubmitted.what",
    whenKey: "web.notificationSchedule.teacher.homeworkSubmitted.when",
  },
  {
    key: "wise_payments",
    templates: [
      "payment_pending_teacher",
      "payment_marked_sent_teacher",
      "wise_confirm_reminder_teacher",
    ],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.wisePayments.what",
    whenKey: "web.notificationSchedule.teacher.wisePayments.when",
  },
  {
    key: "card_sale",
    templates: ["payment_received_teacher"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.cardSale.what",
    whenKey: "web.notificationSchedule.teacher.cardSale.when",
  },
  {
    key: "refunds",
    templates: ["refund_issued_teacher", "dispute_lost_teacher"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.refunds.what",
    whenKey: "web.notificationSchedule.teacher.refunds.when",
  },
  {
    key: "stripe_account",
    templates: ["stripe_ready_teacher", "stripe_requirements_teacher"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.stripeAccount.what",
    whenKey: "web.notificationSchedule.teacher.stripeAccount.when",
  },
  {
    key: "account_disabled",
    templates: ["account_disabled_teacher"],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.accountDisabled.what",
    whenKey: "web.notificationSchedule.teacher.accountDisabled.when",
  },
  {
    key: "package_finished",
    templates: ["package_consumed_teacher"],
    group: "student_progress",
    whatKey: "web.notificationSchedule.teacher.packageFinished.what",
    whenKey: "web.notificationSchedule.teacher.packageFinished.when",
  },
  {
    key: "subscription",
    templates: ["subscription_trial_ending", "subscription_founding_price_locked"],
    group: "subscription",
    whatKey: "web.notificationSchedule.teacher.subscription.what",
    whenKey: "web.notificationSchedule.teacher.subscription.when",
  },
  {
    key: "billing",
    templates: [
      "subscription_payment_succeeded",
      "subscription_payment_failed",
      "subscription_canceled",
    ],
    group: ALWAYS,
    whatKey: "web.notificationSchedule.teacher.billing.what",
    whenKey: "web.notificationSchedule.teacher.billing.when",
  },
  {
    key: "class_insights",
    templates: ["lesson_insights_review_teacher"],
    group: "student_progress",
    whatKey: "web.notificationSchedule.teacher.classInsights.what",
    whenKey: "web.notificationSchedule.teacher.classInsights.when",
  },
  {
    // Key preserved (it is a stable identifier in the settings UI); what it
    // announces changed in D-125 from "post in your groups" to the week's
    // prepared acquisition plan.
    key: "facebook_groups_reminder",
    templates: ["student_acquisition_plan_teacher"],
    group: "growth",
    whatKey: "web.notificationSchedule.teacher.weeklyPlan.what",
    whenKey: "web.notificationSchedule.teacher.weeklyPlan.when",
  },
  {
    key: "chat_messages",
    templates: ["chat_message_teacher"],
    group: "messages",
    whatKey: "web.notificationSchedule.teacher.chatMessages.what",
    whenKey: "web.notificationSchedule.teacher.chatMessages.when",
  },
];

// Exported for the completeness test — not consumed by any other component.
export { STUDENT_ROWS, TEACHER_ROWS, ALWAYS };

/**
 * Groups in reading order: the gateable categories in the audience's canonical
 * category order, then everything ungateable. `always` is deliberately LAST —
 * it is the group the reader can do nothing about, so it should not be the
 * first thing they read.
 */
function groupOrder(audience: "student" | "teacher"): readonly Group[] {
  const categories =
    audience === "student" ? NOTIFICATION_CATEGORIES : TEACHER_NOTIFICATION_CATEGORIES;
  return [...categories, ALWAYS];
}

/** Prefs shape both recipient types share at runtime. */
type Prefs = { channelPrefs?: Partial<Record<string, string[]>> } & Partial<
  Record<string, unknown>
>;

export async function NotificationSchedule({
  audience,
  prefs = null,
}: {
  audience: "student" | "teacher";
  /**
   * The RECIPIENT'S OWN preferences, when the reader is the recipient — each
   * group then carries its current state, which is the only thing that turns
   * this from a brochure into an answer. Omitted when the reader is looking at
   * someone else's schedule (a teacher reading what her students get), where
   * there is no single set of preferences to report.
   */
  prefs?: Prefs | null;
}) {
  const t = await getT();
  const rows = audience === "student" ? STUDENT_ROWS : TEACHER_ROWS;
  const channelNote =
    audience === "student"
      ? t("web.notificationSchedule.studentChannelNote")
      : t("web.notificationSchedule.teacherChannelNote");

  const groups = groupOrder(audience)
    .map((group) => ({ group, rows: rows.filter((r) => r.group === group) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-6">
      {groups.map(({ group, rows: groupRows }) => {
        const isAlways = group === ALWAYS;
        const label = isAlways
          ? t("web.notificationSchedule.alwaysSentGroup")
          : t(CATEGORY_LABEL_KEYS[group] ?? "web.notificationSchedule.alwaysSentGroup");
        return (
          <section key={group} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              {/* h3, not h4: the enclosing SettingsSection carries the h2, and
                  skipping a level is a real defect for anyone navigating by
                  headings. `level` is the size, `as` is the outline. */}
              <Heading level={4} as="h3">
                {label}
              </Heading>
              <GroupState group={group} prefs={prefs} t={t} />
            </div>
            {/* A definition list, because every row IS a term and its
                definition. It was two sibling <span>s in an <li>, which reads
                to a screen reader as one run-on line with no relationship
                between the halves. */}
            <dl className="divide-border divide-y rounded-md border">
              {groupRows.map((row) => (
                <div
                  key={row.key}
                  className="grid gap-x-4 gap-y-0.5 px-3 py-2.5 text-sm lg:grid-cols-3"
                >
                  <dt className="font-medium">{t(row.whatKey)}</dt>
                  <dd className="text-muted-foreground lg:col-span-2">{t(row.whenKey)}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      <p className="text-muted-foreground text-sm">{channelNote}</p>
    </div>
  );
}

/**
 * Whether this group currently reaches the recipient, as a WORD — never as a
 * colour alone (D-140). Renders nothing at all when there are no preferences
 * to report, rather than guessing a default and stating it as fact.
 */
function GroupState({
  group,
  prefs,
  t,
}: {
  group: Group;
  prefs: Prefs | null;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
}) {
  if (group === ALWAYS) {
    return <Badge variant="outline">{t("web.notificationSchedule.cannotTurnOff")}</Badge>;
  }
  if (!prefs) return null;

  if (!isCategoryEnabled(prefs, group)) {
    return <Badge variant="secondary">{t("web.notificationSchedule.groupOff")}</Badge>;
  }

  // A restriction is worth naming: "On" over a category that only ever emails
  // is true but unhelpful.
  const allowed = getAllowedChannels(prefs, group);
  if (allowed && allowed.length === 1) {
    return (
      <Badge variant="success">
        {t(
          allowed[0] === "email"
            ? "web.notificationSchedule.groupOnEmailOnly"
            : "web.notificationSchedule.groupOnPushOnly",
        )}
      </Badge>
    );
  }
  return <Badge variant="success">{t("web.notificationSchedule.groupOn")}</Badge>;
}
