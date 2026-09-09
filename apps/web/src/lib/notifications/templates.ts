// Source of truth for the notification templates.
//
// Template names are a stable contract: notifications.template_name holds
// these strings and the dispatcher routes by exact match. Every template
// ships over push (when the recipient has a device token) with an email
// fallback; there is no third channel.

export const TEMPLATE_NAMES = [
  "booking_confirmation",
  // Pre-class reminders fire at 24h, 1h and 5m before start. There is no
  // five-days-before reminder: teachers asked for it to be removed outright,
  // for their own notifications and their students', so `reminder_5d` /
  // `reminder_5d_teacher` are gone rather than merely disabled. Don't
  // reintroduce them — the five-day mark now only releases `t_5d` class
  // materials (see lib/notifications/reminders.ts).
  "reminder_24h",
  "reminder_1h",
  // 5-minute final reminder: student push/email, fired exactly 5 minutes
  // before scheduled start.
  "reminder_15m",
  // Teacher-recipient pre-class reminders — the teacher mirror of the three
  // student reminders above, at the same 24h/1h/5m offsets. Teacher-voiced
  // copy (the student's name, not the teacher's), push with email fallback,
  // suppressible via the teacher "class_reminders" preference category.
  "reminder_24h_teacher",
  "reminder_1h_teacher",
  "reminder_15m_teacher",
  "cancel_lt24h",
  "cancel_gte24h_with_reschedule",
  "teacher_cancel",
  "reschedule_confirm",
  "payment_received",
  "magic_link",
  "materials_send",
  "payment_pending_teacher",
  "payment_marked_sent_teacher",
  "payment_failed_student",
  "refund_issued_student",
  "refund_issued_teacher",
  // Lost chargeback. A dispute the card issuer decides against the teacher
  // revokes the student's remaining classes and takes the money (plus a
  // dispute fee) out of HER balance — she is the merchant of record under
  // direct charges (D-143). Both sides used to learn about that only by
  // noticing: the package silently read "Reembolsado" for the student, and
  // the teacher had nothing but a Sentry alert routed to ops, not to her.
  // Kept SEPARATE from refund_issued_*: a chargeback is not a refund, the
  // money did not go back voluntarily, and copy that said it did would be
  // wrong about what happened to both of them.
  "dispute_lost_student",
  "dispute_lost_teacher",
  "stripe_ready_teacher",
  "stripe_requirements_teacher",
  "account_disabled_teacher",
  "booking_created_teacher",
  "cancel_lt24h_teacher",
  "cancel_gte24h_teacher",
  "reschedule_confirm_teacher",
  "no_show_student",
  // Pre-expiry nudge: student-recipient, push with email fallback — recovers
  // unused classes into rebookings before they lapse.
  "package_expiry_nudge",
  // Wise confirm reminder: teacher email-only. A daily-ish cron re-pings the
  // teacher about a Wise payment the student marked sent but the teacher
  // hasn't confirmed — money sitting unactivated due to forgetfulness.
  "wise_confirm_reminder_teacher",
  // Stripe sale notification (review item 7): teacher-recipient.
  "payment_received_teacher",
  // Wise mark-sent acknowledgment (review item 6): student-recipient. Confirms
  // "we told your teacher" the moment the student clicks "Ya envié el pago".
  "wise_marked_sent_student",
  // Consumed-package renewal nudge: student variant deep-links to the in-portal
  // repurchase flow at /my-classes/buy; teacher variant is a repeat-purchase
  // opportunity she can follow up on personally.
  "package_consumed_student",
  "package_consumed_teacher",
  // Subscription / monetization (docs/features/subscriptions.md): all
  // teacher-recipient.
  "subscription_trial_ending",
  "subscription_payment_succeeded",
  "subscription_payment_failed",
  "subscription_canceled",
  "subscription_founding_price_locked",
  // Library material assigned: student-recipient. Sent when a teacher assigns a
  // level-library material to a student's account (not tied to a class) — the
  // class-materials path already notifies via materials_send, this closes the
  // account-level gap.
  "library_material_assigned",
  // Lesson-insights post-class review nudge (Phase F,
  // the Phase F design): teacher-recipient. Fired after
  // Phase C (re)generates focus areas for a class, reminding the teacher to run
  // her ~10-second validation pass.
  "lesson_insights_review_teacher",
  // Facebook-groups posting nudge: teacher-recipient. RETIRED as a live send by
  // D-125 — its weekly cron was replaced by the student-acquisition plan nudge
  // below, which says what to post rather than only that she should. The
  // template stays defined so historical notification rows still render.
  "facebook_groups_nudge_teacher",
  // Weekly student-acquisition plan (D-125): teacher-recipient. A Monday cron
  // builds the week's plan and tells her how many actions are waiting and what
  // the first one is. Suppressible via the "growth" teacher preference
  // category, same as the nudge it replaces.
  "student_acquisition_plan_teacher",
  // In-app chat message notifications: push-only, email fallback. Suppressible
  // via the "messages" preference category on both student and teacher sides.
  // Teacher → student uses chat_message; student → teacher uses
  // chat_message_teacher.
  "chat_message",
  "chat_message_teacher",
  // Homework submitted: teacher-recipient. Sent when a student submits homework
  // for one of the teacher's classes, deep-linking to that class's detail so she
  // can review it. Suppressible via the "student_progress" preference category.
  "homework_submitted_teacher",
  // Homework assigned: student-recipient. Sent when an Assignment is created for
  // one of the student's classes — either the teacher authoring one directly, or
  // the auto-draft that fires when her class content contains a
  // [!homework]/[!exercise] callout (docs/features/homework.md).
  // Suppressible via the "class_materials" preference category (same "share me
  // study materials" grouping as materials_send/library_material_assigned).
  "homework_assigned_student",
  // Homework feedback available: student-recipient. Sent when a teacher creates
  // a HomeworkFeedback for the student's latest attempt — covers all three
  // decisions (approved/resubmission_requested/rejected) via one template with
  // decision-specific copy, rather than three near-identical templates.
  // Suppressible via the "class_materials" category, same as the rest of the
  // homework lifecycle notifications (docs/features/homework.md).
  "homework_feedback_available_student",
  // Due-soon reminder: student-recipient. Fired once, a fixed window (default
  // 24h) before an assignment's dueAt, for a student who hasn't submitted yet.
  // Suppressible via the "class_materials" category, same as the rest of the
  // homework lifecycle (docs/features/homework.md).
  "homework_due_soon_student",
  // Overdue reminder: student-recipient. Fired once, after dueAt has passed
  // with no submission — regardless of whether late submission is allowed
  // (the point is to surface the miss, not to gate it). Same category as
  // homework_due_soon_student.
  "homework_overdue_student",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// Templates that target the teacher (recipientType="teacher"). The
// dispatcher uses this to pick the recipient-loading branch. Keep in sync
// with the producers in src/lib/notifications/enqueue.ts.
export const TEACHER_RECIPIENT_TEMPLATES: ReadonlySet<TemplateName> = new Set([
  "reminder_24h_teacher",
  "reminder_1h_teacher",
  "reminder_15m_teacher",
  "payment_pending_teacher",
  "payment_marked_sent_teacher",
  "refund_issued_teacher",
  "dispute_lost_teacher",
  "stripe_ready_teacher",
  "stripe_requirements_teacher",
  "account_disabled_teacher",
  "booking_created_teacher",
  "cancel_lt24h_teacher",
  "cancel_gte24h_teacher",
  "reschedule_confirm_teacher",
  "wise_confirm_reminder_teacher",
  "payment_received_teacher",
  "package_consumed_teacher",
  "subscription_trial_ending",
  "subscription_payment_succeeded",
  "subscription_payment_failed",
  "subscription_canceled",
  "subscription_founding_price_locked",
  "lesson_insights_review_teacher",
  "facebook_groups_nudge_teacher",
  "student_acquisition_plan_teacher",
  "chat_message_teacher",
  "homework_submitted_teacher",
]);

/**
 * Templates that are still DEFINED but no longer have a live producer.
 *
 * A template name is a stable contract — `notifications.template_name`
 * persists it and the dispatcher routes by exact match — so retiring a send
 * means deleting its cron, not its renderer: rows already in the table must
 * still render. Listing it here is what keeps that deliberate, and what stops
 * the notification-schedule coverage guard demanding a "what we send and when"
 * row for something we no longer send.
 */
export const RETIRED_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  // D-125: the fortnightly "post in your Facebook groups again" cron was
  // replaced by the weekly student-acquisition plan nudge, which says WHAT to
  // post rather than only that she should.
  "facebook_groups_nudge_teacher",
]);

export function isRetiredTemplate(t: TemplateName): boolean {
  return RETIRED_TEMPLATES.has(t);
}

export function isTeacherRecipientTemplate(t: TemplateName): boolean {
  return TEACHER_RECIPIENT_TEMPLATES.has(t);
}

// Supported languages for outbound copy (Student.locale 'es-MX' → 'es_MX',
// 'en' → 'en'; the email renderer branches on these codes). The list, the type,
// and the hyphen→underscore bridge all live in the shared locale registry now,
// so registering a language extends outbound copy in lockstep with the in-app
// catalog. Re-exported here to keep existing `@/lib/notifications/templates`
// imports stable.
export { LANGUAGE_CODES, localeToLanguageCode, type LanguageCode } from "@spiralclass/shared";

// -----------------------------
// Template variable contracts
// -----------------------------
// Each template has a fixed set of body variables the producers supply and
// the email/push renderers consume.

// `calendarStartIso` / `calendarEndIso` are email-only extras carried on the
// booking templates so the email path can build an "Add to calendar" link
// (lib/calendar). `joinPathSuffix` drives the email's "Join video call" button;
// `classPathSuffix` is the push deep-link suffix.
export type TemplateVariables = {
  booking_confirmation: {
    teacherName: string;
    classDateTime: string;
    classesRemaining: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  reminder_24h: {
    teacherName: string;
    classDateTime: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  reminder_1h: {
    teacherName: string;
    classDateTime: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  reminder_15m: {
    teacherName: string;
    classDateTime: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  // Teacher-recipient reminders. Copy is teacher-voiced and names the STUDENT,
  // so these carry `studentName` instead of `teacherName`. `classPathSuffix` is
  // the teacher's dashboard class-detail path; `joinPathSuffix` (when present)
  // is the teacher's video-call route.
  reminder_24h_teacher: {
    studentName: string;
    classDateTime: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  reminder_1h_teacher: {
    studentName: string;
    classDateTime: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  reminder_15m_teacher: {
    studentName: string;
    classDateTime: string;
    joinPathSuffix?: string;
    classPathSuffix?: string;
  };
  cancel_lt24h: {
    teacherName: string;
    originalDateTime: string;
    // Push deep-link (`r/re/<bookingId>`). Mobile's routeForDeepLink maps this
    // prefix to the student book tab so they can pick a new slot.
    reschedulePathSuffix?: string;
  };
  cancel_gte24h_with_reschedule: {
    teacherName: string;
    originalDateTime: string;
    reschedulePathSuffix: string;
  };
  teacher_cancel: {
    teacherName: string;
    originalDateTime: string;
    reschedulePathSuffix: string;
  };
  reschedule_confirm: {
    teacherName: string;
    oldDateTime: string;
    newDateTime: string;
    classPathSuffix?: string;
  };
  payment_received: {
    teacherName: string;
    packageName: string;
    amount: string;
    portalPathSuffix: string;
  };
  magic_link: {
    teacherName: string;
    expiryMinutes: string;
    magicLinkPathSuffix: string;
  };
  materials_send: {
    teacherName: string;
    classDateTime: string;
    materialsPathSuffix: string;
  };
  payment_pending_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    wiseReference: string;
    paymentPathSuffix: string;
  };
  payment_marked_sent_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    wiseReference: string;
    paymentPathSuffix: string;
  };
  wise_confirm_reminder_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    wiseReference: string;
    paymentPathSuffix: string;
  };
  payment_failed_student: {
    teacherName: string;
    packageName: string;
    // Path back to the teacher's public booking page so the student can
    // restart checkout. The original payment row is closed; "retry" means
    // creating a new Payment via the checkout action.
    retryPathSuffix: string;
  };
  refund_issued_student: {
    teacherName: string;
    packageName: string;
    amount: string;
    // In-portal classes list, so the student can see their remaining balance
    // after the refund. Push-only — no action button on email.
    portalPathSuffix?: string;
  };
  refund_issued_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    paymentPathSuffix: string;
  };
  dispute_lost_student: {
    teacherName: string;
    packageName: string;
    amount: string;
    // In-portal classes list, so the student can see what is left. Push-only —
    // no action button on email, same as the refund notice.
    portalPathSuffix?: string;
  };
  dispute_lost_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    paymentPathSuffix: string;
  };
  stripe_ready_teacher: {
    teacherName: string;
    // Public booking link (e.g. `b/<slug>`) — the link the teacher will share
    // with students now that Stripe is accepting cards.
    bookingLinkPathSuffix: string;
  };
  stripe_requirements_teacher: {
    teacherName: string;
    // Path to the in-app Stripe settings page so the teacher can resume their
    // Connect onboarding.
    stripeSettingsPathSuffix: string;
  };
  account_disabled_teacher: {
    teacherName: string;
    reason: string;
  };
  booking_created_teacher: {
    teacherName: string;
    studentName: string;
    classDateTime: string;
    dashboardPathSuffix: string;
    calendarStartIso?: string;
    calendarEndIso?: string;
  };
  lesson_insights_review_teacher: {
    teacherName: string;
    studentName: string;
    count: number;
    dashboardPathSuffix: string;
  };
  facebook_groups_nudge_teacher: {
    teacherName: string;
    // How many groups the teacher has saved — personalises the reminder copy.
    groupCount: number;
    dashboardPathSuffix: string;
  };
  student_acquisition_plan_teacher: {
    teacherName: string;
    // How many prepared actions are waiting in this week's plan.
    actionCount: number;
    // The headline of the first one, already written for her ("Share a tip in
    // Oaxaca Expats"). This is what makes the nudge a plan rather than a nag.
    firstAction: string;
    // Roughly how long the whole week's plan should take.
    minutes: number;
    dashboardPathSuffix: string;
  };
  cancel_lt24h_teacher: {
    teacherName: string;
    studentName: string;
    originalDateTime: string;
    // True when the (teacher, student) link is archived — the student-side
    // notice was suppressed, and the teacher email says so.
    studentArchived?: boolean;
    // Teacher dashboard booking detail (`dashboard/classes/<id>`). Push-only.
    dashboardPathSuffix?: string;
  };
  cancel_gte24h_teacher: {
    teacherName: string;
    studentName: string;
    originalDateTime: string;
    studentArchived?: boolean;
    dashboardPathSuffix?: string;
  };
  reschedule_confirm_teacher: {
    teacherName: string;
    studentName: string;
    oldDateTime: string;
    newDateTime: string;
    dashboardPathSuffix?: string;
  };
  payment_received_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    amount: string;
    paymentPathSuffix: string;
  };
  wise_marked_sent_student: {
    teacherName: string;
    packageName: string;
    wiseReference: string;
    // In-portal classes list. Push-only — no action button on email.
    portalPathSuffix?: string;
  };
  no_show_student: {
    teacherName: string;
    originalDateTime: string;
    // The no-show booking's detail page. Push-only.
    classPathSuffix?: string;
  };
  package_expiry_nudge: {
    teacherName: string;
    packageName: string;
    classesRemaining: string;
    expiryDate: string;
    // Public booking page (`b/<slug>`) — used by the email button.
    bookingLinkPathSuffix: string;
    // In-app book tab so a signed-in student spends remaining classes from this
    // package instead of landing on the public "buy a new package" page.
    // Push-only.
    bookPathSuffix?: string;
  };
  package_consumed_student: {
    teacherName: string;
    packageName: string;
    // In-portal repurchase flow (`mis-clases/buy`) — the signed-in path, not
    // the anonymous booking page, so a returning student never re-enters their
    // email (and can't fork their account with a typo).
    renewPathSuffix: string;
  };
  package_consumed_teacher: {
    teacherName: string;
    studentName: string;
    packageName: string;
    // Teacher dashboard page for this student (`dashboard/students/<id>`) so she
    // can follow up on the repeat-purchase opportunity directly.
    studentPathSuffix: string;
    // True when the student's own renewal notice was actually enqueued (their
    // `expiry_reminders` category is on). False for imported / opted-out
    // students who receive no automatic notice — the teacher copy then drops the
    // "we already told them" line so the email never claims a send that didn't
    // happen.
    studentNotified: boolean;
  };
  // Subscription / monetization — all teacher-recipient. Display values are
  // computed at enqueue time and carried in notification.metadata, so the
  // dispatcher's buildVariables only re-reads metadata + teacherName.
  // `billingPathSuffix` deep-links to settings/billing.
  subscription_trial_ending: {
    teacherName: string;
    daysRemaining: string;
    billingPathSuffix: string;
  };
  subscription_payment_succeeded: {
    teacherName: string;
    amount: string;
    nextChargeDate: string;
    billingPathSuffix: string;
  };
  subscription_payment_failed: {
    teacherName: string;
    graceDays: string;
    billingPathSuffix: string;
  };
  subscription_canceled: {
    teacherName: string;
    billingPathSuffix: string;
  };
  subscription_founding_price_locked: {
    teacherName: string;
    amount: string;
    billingPathSuffix: string;
  };
  library_material_assigned: {
    teacherName: string;
    // Display name of the assigned material (falls back to a generic label when
    // the library item has no title).
    materialLabel: string;
    // Student portal materials page (`mis-clases/materiales`) where the assigned
    // item is listed — the signed download URL is minted there.
    materialsPathSuffix: string;
  };
  // In-app chat message notifications. Push-only with email fallback. `preview`
  // is the message body excerpt (text) or a short type label ("Voice message" /
  // "Video") for media messages. `chatPathSuffix` is the deep-link path.
  chat_message: {
    teacherName: string;
    preview: string;
    chatPathSuffix: string;
  };
  chat_message_teacher: {
    teacherName: string;
    studentName: string;
    preview: string;
    chatPathSuffix: string;
  };
  homework_submitted_teacher: {
    teacherName: string;
    studentName: string;
    // The assignment's title (carried in metadata at enqueue time).
    assignmentTitle: string;
    // Teacher dashboard class-detail path (`dashboard/classes/<id>`) — where she
    // reviews the class the homework belongs to. Push deep-link + email CTA.
    dashboardPathSuffix: string;
  };
  homework_assigned_student: {
    teacherName: string;
    assignmentTitle: string;
    // Student mobile deep-link path (`s/class/<id>`) — the class the assignment
    // belongs to, where the homework card lives.
    classPathSuffix: string;
  };
  homework_feedback_available_student: {
    teacherName: string;
    assignmentTitle: string;
    // Which of the three decisions this is — drives the push/email copy.
    decision: "approved" | "resubmission_requested" | "rejected";
    // Student mobile deep-link path (`s/class/<id>`) — same class the
    // homework_assigned_student notification points at.
    classPathSuffix: string;
  };
  homework_due_soon_student: {
    teacherName: string;
    assignmentTitle: string;
    dueDate: string;
    classPathSuffix: string;
  };
  homework_overdue_student: {
    teacherName: string;
    assignmentTitle: string;
    classPathSuffix: string;
  };
};

// Returns the URL-button path suffix for a template, or null when it has no
// action button. The email renderer turns this into the primary CTA link; push
// deep-links reuse the same suffix.
export function urlButtonSuffix<T extends TemplateName>(
  templateName: T,
  vars: TemplateVariables[T],
): string | null {
  switch (templateName) {
    case "cancel_gte24h_with_reschedule":
    case "teacher_cancel":
      return (vars as TemplateVariables["cancel_gte24h_with_reschedule"]).reschedulePathSuffix;
    case "payment_received":
      return (vars as TemplateVariables["payment_received"]).portalPathSuffix;
    case "magic_link":
      return (vars as TemplateVariables["magic_link"]).magicLinkPathSuffix;
    case "materials_send":
      return (vars as TemplateVariables["materials_send"]).materialsPathSuffix;
    case "payment_pending_teacher":
    case "payment_marked_sent_teacher":
    case "wise_confirm_reminder_teacher":
      return (vars as TemplateVariables["payment_pending_teacher"]).paymentPathSuffix;
    case "payment_received_teacher":
      return (vars as TemplateVariables["payment_received_teacher"]).paymentPathSuffix;
    case "payment_failed_student":
      return (vars as TemplateVariables["payment_failed_student"]).retryPathSuffix;
    case "refund_issued_teacher":
      return (vars as TemplateVariables["refund_issued_teacher"]).paymentPathSuffix;
    case "dispute_lost_teacher":
      return (vars as TemplateVariables["dispute_lost_teacher"]).paymentPathSuffix;
    case "stripe_ready_teacher":
      return (vars as TemplateVariables["stripe_ready_teacher"]).bookingLinkPathSuffix;
    case "stripe_requirements_teacher":
      return (vars as TemplateVariables["stripe_requirements_teacher"]).stripeSettingsPathSuffix;
    case "booking_created_teacher":
      return (vars as TemplateVariables["booking_created_teacher"]).dashboardPathSuffix;
    case "lesson_insights_review_teacher":
      return (vars as TemplateVariables["lesson_insights_review_teacher"]).dashboardPathSuffix;
    case "facebook_groups_nudge_teacher":
      return (vars as TemplateVariables["facebook_groups_nudge_teacher"]).dashboardPathSuffix;
    case "student_acquisition_plan_teacher":
      return (vars as TemplateVariables["student_acquisition_plan_teacher"]).dashboardPathSuffix;
    case "package_expiry_nudge":
      return (vars as TemplateVariables["package_expiry_nudge"]).bookingLinkPathSuffix;
    case "package_consumed_student":
      return (vars as TemplateVariables["package_consumed_student"]).renewPathSuffix;
    case "package_consumed_teacher":
      return (vars as TemplateVariables["package_consumed_teacher"]).studentPathSuffix;
    case "subscription_trial_ending":
    case "subscription_payment_succeeded":
    case "subscription_payment_failed":
    case "subscription_canceled":
    case "subscription_founding_price_locked":
      return (vars as TemplateVariables["subscription_trial_ending"]).billingPathSuffix;
    case "library_material_assigned":
      return (vars as TemplateVariables["library_material_assigned"]).materialsPathSuffix;
    // Booking confirmation + reminders carry a "Join video call" button only when
    // the dispatcher set joinPathSuffix (call available for this booking).
    case "booking_confirmation":
    case "reminder_24h":
    case "reminder_1h":
    case "reminder_15m":
    // Teacher reminders carry the same optional "Join video call" button.
    case "reminder_24h_teacher":
    case "reminder_1h_teacher":
    case "reminder_15m_teacher":
      return (vars as TemplateVariables["booking_confirmation"]).joinPathSuffix ?? null;
    case "reschedule_confirm":
    case "cancel_lt24h":
    case "refund_issued_student":
    // No action button. There is nothing for the student to DO about a lost
    // chargeback from an email, and a "view your classes" CTA on a notice that
    // their classes were removed reads as a taunt.
    case "dispute_lost_student":
    case "account_disabled_teacher":
    case "cancel_lt24h_teacher":
    case "cancel_gte24h_teacher":
    case "reschedule_confirm_teacher":
    case "no_show_student":
    case "wise_marked_sent_student":
      return null;
    case "chat_message":
      return (vars as TemplateVariables["chat_message"]).chatPathSuffix;
    case "chat_message_teacher":
      return (vars as TemplateVariables["chat_message_teacher"]).chatPathSuffix;
    case "homework_submitted_teacher":
      return (vars as TemplateVariables["homework_submitted_teacher"]).dashboardPathSuffix;
    case "homework_assigned_student":
      return (vars as TemplateVariables["homework_assigned_student"]).classPathSuffix;
    case "homework_feedback_available_student":
      return (vars as TemplateVariables["homework_feedback_available_student"]).classPathSuffix;
    case "homework_due_soon_student":
      return (vars as TemplateVariables["homework_due_soon_student"]).classPathSuffix;
    case "homework_overdue_student":
      return (vars as TemplateVariables["homework_overdue_student"]).classPathSuffix;
  }
  const _exhaustive: never = templateName;
  throw new Error(`unhandled template ${_exhaustive}`);
}
