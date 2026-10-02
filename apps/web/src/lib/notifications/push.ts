import { createT, languageCodeToLocale } from "@spiralclass/shared";
// Notification push RENDERERS — the copy a push notification carries.
//
// `renderPush(template, lang, vars) → { title, body, deepLink }` is the single
// place a push's words are decided, and it has three readers: the Web Push
// transport (lib/notifications/web-push.ts), the dispatcher, and the in-app
// inbox (lib/notifications/inbox.ts), which renders the same title/body so what
// a teacher sees in her inbox can never drift from what she was sent.
//
// ⚠️ **There is no transport in this file.** Web Push is the transport;
// `push` is one CHANNEL with one transport, and everything here decides only
// the words a push carries.

import type { LanguageCode, TemplateName, TemplateVariables } from "./templates";

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export type RenderedPush = {
  title: string;
  body: string;
  // Relative path the app should route to on tap (e.g. `r/p/<pkg>`).
  // null for templates that have no actionable destination.
  deepLink: string | null;
  // Counterpart display name for deep links that land on a dynamic-segment
  // screen the client can't otherwise label (e.g. a chat thread) —
  // carried in the push `data` payload so the client doesn't have to look it
  // up separately. Undefined for templates that don't need it.
  deepLinkName?: string;
};

export function renderPush<T extends TemplateName>(
  templateName: T,
  language: LanguageCode,
  vars: TemplateVariables[T],
): RenderedPush {
  const t = createT(languageCodeToLocale(language));
  switch (templateName) {
    case "booking_confirmation": {
      const v = vars as TemplateVariables["booking_confirmation"];
      return {
        title: t("push.bookingConfirmation.title"),
        // Warm, second-person — mirrors the confirmation email's tone. A "·"
        // separator (not a period) keeps the classes-left count without
        // producing a double period after times that end in "p.m.".
        body: t("push.bookingConfirmation.body", {
          teacherName: v.teacherName,
          classDateTime: v.classDateTime,
          classesRemaining: v.classesRemaining,
        }),
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "reminder_24h":
    case "reminder_1h":
    case "reminder_15m": {
      const v = vars as TemplateVariables["reminder_24h"];
      const lead =
        templateName === "reminder_24h"
          ? t("classes.group.tomorrow")
          : templateName === "reminder_1h"
            ? t("push.reminder24h.lead")
            : t("push.reminder24h.lead2");
      return {
        title: t("push.reminder24h.title", { lead }),
        // No trailing period: classDateTime ends in the "p.m." abbreviation, so
        // an appended sentence period renders as a double period ("p.m..").
        body: t("push.reminder24h.body", {
          teacherName: v.teacherName,
          classDateTime: v.classDateTime,
        }),
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "reminder_24h_teacher":
    case "reminder_1h_teacher":
    case "reminder_15m_teacher": {
      const v = vars as TemplateVariables["reminder_24h_teacher"];
      const lead =
        templateName === "reminder_24h_teacher"
          ? t("classes.group.tomorrow")
          : templateName === "reminder_1h_teacher"
            ? t("push.reminder24h.lead")
            : t("push.reminder24h.lead2");
      return {
        title: t("push.reminder24h.title", { lead }),
        // Teacher-voiced: names the student, not the teacher. No trailing period
        // — classDateTime ends in "p.m." (double-period otherwise).
        body: t("push.reminder24hTeacher.body", {
          studentName: v.studentName,
          classDateTime: v.classDateTime,
        }),
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "cancel_lt24h": {
      const v = vars as TemplateVariables["cancel_lt24h"];
      return {
        title: t("push.cancelLt24h.title"),
        body: t("push.cancelLt24h.body", {
          originalDateTime: v.originalDateTime,
          teacherName: v.teacherName,
        }),
        // Rebook link → the student book surface (not the canceled booking's
        // reschedule screen) so the student can pick a new slot.
        deepLink: v.reschedulePathSuffix ?? null,
      };
    }
    case "cancel_gte24h_with_reschedule":
    case "teacher_cancel": {
      const v = vars as TemplateVariables["cancel_gte24h_with_reschedule"];
      return {
        title:
          templateName === "teacher_cancel"
            ? t("push.cancelGte24hWithReschedule.title")
            : t("push.cancelLt24h.title"),
        body: t("push.cancelGte24hWithReschedule.body", {
          originalDateTime: v.originalDateTime,
          teacherName: v.teacherName,
        }),
        deepLink: v.reschedulePathSuffix,
      };
    }
    case "reschedule_confirm": {
      const v = vars as TemplateVariables["reschedule_confirm"];
      return {
        title: t("push.rescheduleConfirm.title"),
        body: t("push.rescheduleConfirm.body", {
          oldDateTime: v.oldDateTime,
          newDateTime: v.newDateTime,
          teacherName: v.teacherName,
        }),
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "payment_received": {
      const v = vars as TemplateVariables["payment_received"];
      return {
        title: t("push.paymentReceived.title"),
        body: t("push.paymentReceived.body", {
          packageName: v.packageName,
          teacherName: v.teacherName,
          amount: v.amount,
        }),
        deepLink: v.portalPathSuffix,
      };
    }
    case "magic_link": {
      const v = vars as TemplateVariables["magic_link"];
      return {
        title: t("push.magicLink.title"),
        body: t("push.magicLink.body", {
          teacherName: v.teacherName,
          expiryMinutes: v.expiryMinutes,
        }),
        deepLink: v.magicLinkPathSuffix,
      };
    }
    case "materials_send": {
      const v = vars as TemplateVariables["materials_send"];
      return {
        title: t("students.detail.classMaterials"),
        body: t("push.materialsSend.body", {
          classDateTime: v.classDateTime,
          teacherName: v.teacherName,
        }),
        deepLink: v.materialsPathSuffix,
      };
    }
    case "payment_pending_teacher": {
      const v = vars as TemplateVariables["payment_pending_teacher"];
      return {
        title: t("push.paymentPendingTeacher.title"),
        body: t("push.paymentPendingTeacher.body", {
          studentName: v.studentName,
          packageName: v.packageName,
          amount: v.amount,
          wiseReference: v.wiseReference,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "payment_marked_sent_teacher": {
      const v = vars as TemplateVariables["payment_marked_sent_teacher"];
      return {
        title: t("push.paymentMarkedSentTeacher.title"),
        body: t("push.paymentMarkedSentTeacher.body", {
          studentName: v.studentName,
          amount: v.amount,
          packageName: v.packageName,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "lesson_insights_review_teacher": {
      const v = vars as TemplateVariables["lesson_insights_review_teacher"];
      return {
        title: t("push.lessonInsightsReviewTeacher.title"),
        body: t("push.lessonInsightsReviewTeacher.body", { studentName: v.studentName }),
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "wise_confirm_reminder_teacher": {
      const v = vars as TemplateVariables["wise_confirm_reminder_teacher"];
      return {
        title: t("push.wiseConfirmReminderTeacher.title"),
        body: t("push.wiseConfirmReminderTeacher.body", {
          studentName: v.studentName,
          amount: v.amount,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "payment_failed_student": {
      const v = vars as TemplateVariables["payment_failed_student"];
      return {
        title: t("push.paymentFailedStudent.title"),
        body: t("push.paymentFailedStudent.body", {
          packageName: v.packageName,
          teacherName: v.teacherName,
        }),
        deepLink: v.retryPathSuffix,
      };
    }
    case "refund_issued_student": {
      const v = vars as TemplateVariables["refund_issued_student"];
      return {
        title: t("push.refundIssuedStudent.title"),
        body: t("push.refundIssuedStudent.body", {
          amount: v.amount,
          packageName: v.packageName,
          teacherName: v.teacherName,
        }),
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "refund_issued_teacher": {
      const v = vars as TemplateVariables["refund_issued_teacher"];
      return {
        title: t("push.refundIssuedStudent.title"),
        body: t("push.refundIssuedTeacher.body", {
          amount: v.amount,
          studentName: v.studentName,
          packageName: v.packageName,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "dispute_lost_student": {
      const v = vars as TemplateVariables["dispute_lost_student"];
      return {
        title: t("push.disputeLostStudent.title"),
        body: t("push.disputeLostStudent.body", { amount: v.amount, packageName: v.packageName }),
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "dispute_lost_teacher": {
      const v = vars as TemplateVariables["dispute_lost_teacher"];
      return {
        title: t("push.disputeLostTeacher.title"),
        body: t("push.disputeLostTeacher.body", {
          amount: v.amount,
          studentName: v.studentName,
          packageName: v.packageName,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "stripe_ready_teacher": {
      const v = vars as TemplateVariables["stripe_ready_teacher"];
      return {
        title: t("push.stripeReadyTeacher.title"),
        body: t("push.stripeReadyTeacher.body"),
        deepLink: v.bookingLinkPathSuffix,
      };
    }
    case "stripe_requirements_teacher": {
      const v = vars as TemplateVariables["stripe_requirements_teacher"];
      return {
        title: t("push.stripeRequirementsTeacher.title"),
        body: t("push.stripeRequirementsTeacher.body"),
        deepLink: v.stripeSettingsPathSuffix,
      };
    }
    case "account_disabled_teacher": {
      return {
        title: t("web.notificationSchedule.teacher.accountDisabled.what"),
        body: t("push.accountDisabledTeacher.body"),
        deepLink: null,
      };
    }
    case "booking_created_teacher": {
      const v = vars as TemplateVariables["booking_created_teacher"];
      return {
        title: t("push.bookingCreatedTeacher.title"),
        // No trailing period — see booking_confirmation: classDateTime ends in
        // "p.m.", so appending "." produces a double period.
        body: t("push.bookingCreatedTeacher.body", {
          studentName: v.studentName,
          classDateTime: v.classDateTime,
        }),
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "cancel_lt24h_teacher": {
      const v = vars as TemplateVariables["cancel_lt24h_teacher"];
      return {
        title: t("push.cancelLt24hTeacher.title"),
        body: t("push.cancelLt24hTeacher.body", {
          studentName: v.studentName,
          originalDateTime: v.originalDateTime,
        }),
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "cancel_gte24h_teacher": {
      const v = vars as TemplateVariables["cancel_gte24h_teacher"];
      return {
        title: t("push.cancelLt24h.title"),
        body: t("push.cancelGte24hTeacher.body", {
          studentName: v.studentName,
          originalDateTime: v.originalDateTime,
        }),
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "reschedule_confirm_teacher": {
      const v = vars as TemplateVariables["reschedule_confirm_teacher"];
      return {
        title: t("push.rescheduleConfirm.title"),
        body: t("push.rescheduleConfirmTeacher.body", {
          studentName: v.studentName,
          oldDateTime: v.oldDateTime,
          newDateTime: v.newDateTime,
        }),
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "payment_received_teacher": {
      const v = vars as TemplateVariables["payment_received_teacher"];
      return {
        title: t("push.paymentReceivedTeacher.title"),
        body: t("push.paymentReceivedTeacher.body", {
          studentName: v.studentName,
          packageName: v.packageName,
          amount: v.amount,
        }),
        deepLink: v.paymentPathSuffix,
      };
    }
    case "wise_marked_sent_student": {
      const v = vars as TemplateVariables["wise_marked_sent_student"];
      return {
        title: t("push.wiseMarkedSentStudent.title"),
        body: t("push.wiseMarkedSentStudent.body", {
          teacherName: v.teacherName,
          wiseReference: v.wiseReference,
        }),
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "no_show_student": {
      const v = vars as TemplateVariables["no_show_student"];
      return {
        title: t("push.noShowStudent.title"),
        body: t("push.noShowStudent.body", {
          teacherName: v.teacherName,
          originalDateTime: v.originalDateTime,
        }),
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "package_expiry_nudge": {
      const v = vars as TemplateVariables["package_expiry_nudge"];
      return {
        title: t("push.packageExpiryNudge.title"),
        body: t("push.packageExpiryNudge.body", {
          classesRemaining: v.classesRemaining,
          teacherName: v.teacherName,
          expiryDate: v.expiryDate,
        }),
        // In-app book tab, not the public booking page — these are classes
        // already paid for, not a new package to buy.
        deepLink: v.bookPathSuffix ?? v.bookingLinkPathSuffix ?? null,
      };
    }
    case "package_consumed_student": {
      const v = vars as TemplateVariables["package_consumed_student"];
      return {
        title: t("push.packageConsumedStudent.title"),
        body: t("push.packageConsumedStudent.body", {
          packageName: v.packageName,
          teacherName: v.teacherName,
        }),
        deepLink: v.renewPathSuffix,
      };
    }
    case "package_consumed_teacher": {
      const v = vars as TemplateVariables["package_consumed_teacher"];
      return {
        title: t("push.packageConsumedTeacher.title"),
        body: t("push.packageConsumedTeacher.body", {
          studentName: v.studentName,
          packageName: v.packageName,
        }),
        deepLink: v.studentPathSuffix,
      };
    }
    case "subscription_trial_ending": {
      const v = vars as TemplateVariables["subscription_trial_ending"];
      return {
        title: t("push.subscriptionTrialEnding.title"),
        body: t("push.subscriptionTrialEnding.body", { daysRemaining: v.daysRemaining }),
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_payment_succeeded": {
      const v = vars as TemplateVariables["subscription_payment_succeeded"];
      return {
        title: t("push.paymentReceived.title"),
        body: t("push.subscriptionPaymentSucceeded.body", {
          amount: v.amount,
          nextChargeDate: v.nextChargeDate,
        }),
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_payment_failed": {
      const v = vars as TemplateVariables["subscription_payment_failed"];
      return {
        title: t("push.subscriptionPaymentFailed.title"),
        body: t("push.subscriptionPaymentFailed.body", { graceDays: v.graceDays }),
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_canceled": {
      const v = vars as TemplateVariables["subscription_canceled"];
      return {
        title: t("push.subscriptionCanceled.title"),
        body: t("push.subscriptionCanceled.body"),
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_founding_price_locked": {
      const v = vars as TemplateVariables["subscription_founding_price_locked"];
      return {
        title: t("push.subscriptionFoundingPriceLocked.title"),
        body: t("push.subscriptionFoundingPriceLocked.body", { amount: v.amount }),
        deepLink: v.billingPathSuffix,
      };
    }
    case "library_material_assigned": {
      const v = vars as TemplateVariables["library_material_assigned"];
      return {
        title: t("push.libraryMaterialAssigned.title"),
        body: t("push.libraryMaterialAssigned.body", {
          teacherName: v.teacherName,
          materialLabel: v.materialLabel,
        }),
        deepLink: v.materialsPathSuffix,
      };
    }
    case "homework_assigned_student": {
      const v = vars as TemplateVariables["homework_assigned_student"];
      return {
        title: t("push.homeworkAssignedStudent.title"),
        body: t("push.homeworkAssignedStudent.body", {
          teacherName: v.teacherName,
          assignmentTitle: v.assignmentTitle,
        }),
        deepLink: v.classPathSuffix,
      };
    }
    case "homework_feedback_available_student": {
      const v = vars as TemplateVariables["homework_feedback_available_student"];
      const title =
        v.decision === "approved"
          ? t("push.homeworkFeedbackAvailableStudent.title")
          : v.decision === "resubmission_requested"
            ? t("push.homeworkFeedbackAvailableStudent.title2")
            : t("push.homeworkFeedbackAvailableStudent.title3");
      const body =
        v.decision === "approved"
          ? t("push.homeworkFeedbackAvailableStudent.body", {
              teacherName: v.teacherName,
              assignmentTitle: v.assignmentTitle,
            })
          : v.decision === "resubmission_requested"
            ? t("push.homeworkFeedbackAvailableStudent.body2", {
                teacherName: v.teacherName,
                assignmentTitle: v.assignmentTitle,
              })
            : t("push.homeworkFeedbackAvailableStudent.body3", {
                teacherName: v.teacherName,
                assignmentTitle: v.assignmentTitle,
              });
      return { title, body, deepLink: v.classPathSuffix };
    }
    case "homework_due_soon_student": {
      const v = vars as TemplateVariables["homework_due_soon_student"];
      return {
        title: t("push.homeworkDueSoonStudent.title"),
        body: t("push.homeworkDueSoonStudent.body", {
          assignmentTitle: v.assignmentTitle,
          dueDate: v.dueDate,
        }),
        deepLink: v.classPathSuffix,
      };
    }
    case "homework_overdue_student": {
      const v = vars as TemplateVariables["homework_overdue_student"];
      return {
        title: t("push.homeworkOverdueStudent.title"),
        body: t("push.homeworkOverdueStudent.body", { assignmentTitle: v.assignmentTitle }),
        deepLink: v.classPathSuffix,
      };
    }
    case "facebook_groups_nudge_teacher": {
      const v = vars as TemplateVariables["facebook_groups_nudge_teacher"];
      return {
        title: t("push.facebookGroupsNudgeTeacher.title"),
        body: t("push.facebookGroupsNudgeTeacher.body"),
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "student_acquisition_plan_teacher": {
      const v = vars as TemplateVariables["student_acquisition_plan_teacher"];
      return {
        title: t("push.studentAcquisitionPlanTeacher.title"),
        body: v.firstAction ? v.firstAction : t("push.studentAcquisitionPlanTeacher.body"),
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "chat_message": {
      const v = vars as TemplateVariables["chat_message"];
      return {
        title: t("push.chatMessage.title", { teacherName: v.teacherName }),
        body: v.preview,
        deepLink: v.chatPathSuffix,
        deepLinkName: v.teacherName,
      };
    }
    case "chat_message_teacher": {
      const v = vars as TemplateVariables["chat_message_teacher"];
      return {
        title: t("push.chatMessageTeacher.title", { studentName: v.studentName }),
        body: v.preview,
        deepLink: v.chatPathSuffix,
        deepLinkName: v.studentName,
      };
    }
    case "homework_submitted_teacher": {
      const v = vars as TemplateVariables["homework_submitted_teacher"];
      return {
        title: t("web.notificationSchedule.teacher.homeworkSubmitted.what"),
        body: v.assignmentTitle
          ? t("push.homeworkSubmittedTeacher.body", {
              studentName: v.studentName,
              assignmentTitle: v.assignmentTitle,
            })
          : t("push.homeworkSubmittedTeacher.body2", { studentName: v.studentName }),
        deepLink: v.dashboardPathSuffix,
        deepLinkName: v.studentName,
      };
    }
  }
  const _exhaustive: never = templateName;
  throw new Error(`unhandled template ${_exhaustive}`);
}

// ---------------------------------------------------------------------------
// Push channel routing
// ---------------------------------------------------------------------------

// Urgency class for a template's push. "booking" is reserved for calendar
// changes the recipient needs to notice right away — booking confirmed/
// canceled/rescheduled and imminent-class reminders — and Web Push sends those
// with `urgent` set. Every other template rides "default" so high-frequency or
// low-urgency sends (chat, receipts, nudges) don't cause notification fatigue.
export type PushChannel = "booking" | "default";

const BOOKING_CHANNEL_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  "booking_confirmation",
  "cancel_lt24h",
  "cancel_gte24h_with_reschedule",
  "teacher_cancel",
  "reschedule_confirm",
  "reminder_1h",
  "reminder_15m",
  "reminder_1h_teacher",
  "reminder_15m_teacher",
  "no_show_student",
  "booking_created_teacher",
  "cancel_lt24h_teacher",
  "cancel_gte24h_teacher",
  "reschedule_confirm_teacher",
]);

export function pushChannelForTemplate(templateName: TemplateName): PushChannel {
  return BOOKING_CHANNEL_TEMPLATES.has(templateName) ? "booking" : "default";
}
