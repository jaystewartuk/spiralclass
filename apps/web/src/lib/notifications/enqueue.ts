import type { Prisma, PrismaClient } from "@prisma/client";

// Typed producers for the notifications table.
//
// Every producer writes a row with status='queued' + channel='push'
// (the top of the cascade; the dispatcher overrides at send time based on
// resolveChannel — push when a device token is registered, email as
// fallback). Callers are responsible for
// emitting the `notification.queued` Inngest event — typically via
// `emitNotificationQueued()` in src/lib/notifications/events.ts, called
// after the transaction commits so the event never fires for a rolled-back
// insert.
//
// Template-specific variables that aren't in the schema go into `metadata`
// so the dispatcher can build the channel payload without re-deriving
// state. The dispatcher reads `templateName` + `metadata` + booking/
// payment joins to build the final per-channel content.
//
// Producers are called from:
//   * Stripe webhook handler (payment_received) — see
//     src/lib/payments/webhook-handler.ts
//   * Inngest functions (booking confirmation, reminders, magic_link) —
//     see src/lib/inngest/functions/*
//   * Server actions on cancel/reschedule paths (Slice 5)
//
// ALL producers must pass teacher_id — tenant isolation forbids service-role-bypassing
// queries without a teacher filter.

type Tx = Prisma.TransactionClient | PrismaClient;

async function insert(tx: Tx, data: Prisma.NotificationUncheckedCreateInput): Promise<string> {
  const row = await tx.notification.create({ data, select: { id: true } });
  return row.id;
}

export async function enqueuePaymentReceived(
  tx: Tx,
  input: { teacherId: string; studentId: string; paymentId: string; packageId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId,
    channel: "push",
    templateName: "payment_received",
    status: "queued",
    metadata: { packageId: input.packageId } satisfies PaymentReceivedMetadata,
  });
}
export type PaymentReceivedMetadata = { packageId: string };

export async function enqueueBookingConfirmation(
  tx: Tx,
  input: { teacherId: string; studentId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "booking_confirmation",
    status: "queued",
  });
}

export async function enqueueReminder(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    bookingId: string;
    which: "24h" | "1h" | "15m";
  },
): Promise<string> {
  const templateName =
    input.which === "24h" ? "reminder_24h" : input.which === "1h" ? "reminder_1h" : "reminder_15m";
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName,
    status: "queued",
  });
}

// Teacher mirror of enqueueReminder: the same 24h/1h/5m pre-class reminders,
// addressed to the teacher about her own upcoming class. Teacher-recipient
// (recipientType="teacher"), push with email fallback — the dispatcher routes
// it through the teacher branch and the "class_reminders" teacher category
// gates it. Enqueued alongside the student reminder in schedule-reminders.ts.
export async function enqueueReminderTeacher(
  tx: Tx,
  input: {
    teacherId: string;
    bookingId: string;
    which: "24h" | "1h" | "15m";
  },
): Promise<string> {
  const templateName =
    input.which === "24h"
      ? "reminder_24h_teacher"
      : input.which === "1h"
        ? "reminder_1h_teacher"
        : "reminder_15m_teacher";
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "push",
    templateName,
    status: "queued",
  });
}

export async function enqueueCancelLt24h(
  tx: Tx,
  input: { teacherId: string; studentId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "cancel_lt24h",
    status: "queued",
  });
}

export async function enqueueCancelGte24hWithReschedule(
  tx: Tx,
  input: { teacherId: string; studentId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "cancel_gte24h_with_reschedule",
    status: "queued",
  });
}

export async function enqueueTeacherCancel(
  tx: Tx,
  input: { teacherId: string; studentId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "teacher_cancel",
    status: "queued",
  });
}

export async function enqueueRescheduleConfirm(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    bookingId: string;
    oldScheduledStart: Date;
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "reschedule_confirm",
    status: "queued",
    metadata: {
      oldScheduledStart: input.oldScheduledStart.toISOString(),
    } satisfies RescheduleConfirmMetadata,
  });
}
export type RescheduleConfirmMetadata = { oldScheduledStart: string };

export async function enqueueMagicLink(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    magicLinkUrl: string;
    expiryMinutes: number;
    paymentId?: string;
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId ?? null,
    channel: "push",
    templateName: "magic_link",
    status: "queued",
    metadata: {
      magicLinkUrl: input.magicLinkUrl,
      expiryMinutes: input.expiryMinutes,
    } satisfies MagicLinkMetadata,
  });
}
export type MagicLinkMetadata = { magicLinkUrl: string; expiryMinutes: number };

// Teacher-recipient producers. The dispatcher routes these through the
// teacher branch (email-only) — see [[notifications-audit]].
// `recipientId === teacherId` is enforced by the dispatcher; setting it
// explicitly here keeps the row self-describing.

export async function enqueuePaymentPendingTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "payment_pending_teacher",
    status: "queued",
  });
}

export type InsightsReviewNudgeMetadata = { count: number };

// Post-class review nudge (lesson-insights Phase F): remind the teacher to run
// her ~10-second validation pass once focus areas were generated for a class.
// Teacher email-only (push when a device token exists). `count` rides in
// metadata for the copy; the booking deep-links to the review card.
export async function enqueueInsightsReviewNudge(
  tx: Tx,
  input: { teacherId: string; bookingId: string; count: number },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "lesson_insights_review_teacher",
    status: "queued",
    metadata: { count: input.count } satisfies InsightsReviewNudgeMetadata,
  });
}

// Student ack for "Ya envié el pago" (review item 6): ships email-only and
// tells the student their teacher was notified.
export async function enqueueWiseMarkedSentStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId,
    channel: "push",
    templateName: "wise_marked_sent_student",
    status: "queued",
  });
}

export async function enqueuePaymentReceivedTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "payment_received_teacher",
    status: "queued",
  });
}

export async function enqueuePaymentMarkedSentTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "payment_marked_sent_teacher",
    status: "queued",
  });
}

// Re-ping the teacher about a Wise payment the student marked sent but the
// teacher hasn't confirmed. Email-only (teacher recipient). Dedup (one
// reminder per payment) is enforced by the cron via notifications.paymentId.
export async function enqueueWiseConfirmReminderTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "wise_confirm_reminder_teacher",
    status: "queued",
  });
}

// Remind a teacher to post her booking link in her saved Facebook groups
// again. Email-only (teacher recipient); push when she has a device token.
// Dedup (one nudge per cadence window) is enforced by the cron via the
// notifications.created_at of prior facebook_groups_nudge_teacher rows.
export async function enqueueFacebookGroupsNudgeTeacher(
  tx: Tx,
  input: { teacherId: string; groupCount: number },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "facebook_groups_nudge_teacher",
    status: "queued",
    metadata: { groupCount: input.groupCount } satisfies FacebookGroupsNudgeMetadata,
  });
}
export type FacebookGroupsNudgeMetadata = { groupCount: number };

/**
 * The weekly student-acquisition plan nudge (D-125) — the replacement for the
 * Facebook-groups nudge above. The difference that matters is in the metadata:
 * this one carries what the week's first prepared action IS, so the email says
 * "post this tip in Oaxaca Expats" rather than "you should post something".
 */
export async function enqueueStudentAcquisitionPlanTeacher(
  tx: Tx,
  input: { teacherId: string; actionCount: number; firstAction: string; minutes: number },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "student_acquisition_plan_teacher",
    status: "queued",
    metadata: {
      actionCount: input.actionCount,
      firstAction: input.firstAction,
      minutes: input.minutes,
    } satisfies StudentAcquisitionPlanMetadata,
  });
}
export type StudentAcquisitionPlanMetadata = {
  actionCount: number;
  firstAction: string;
  minutes: number;
};

export async function enqueueMaterialsSend(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    bookingId: string;
    // The LibraryMaterial this send is for. Optional because the manual
    // upload/attach paths have nothing to dedup against (a teacher pressing
    // "send" means send); the timing-driven path in notifications/materials.ts
    // sets it and reads it back as its idempotency key, so a mark the scan
    // re-evaluates every tick queues each material at most once.
    libraryMaterialId?: string | null;
    // storagePath is the canonical reference for file attachments; dispatcher
    // mints a fresh 7-day signed URL on send. materialsUrl is the fallback
    // linkUrl for URL-only attachments. At least one must be set.
    storagePath?: string | null;
    materialsUrl?: string | null;
  },
): Promise<string> {
  const metadata: MaterialsSendMetadata = {
    libraryMaterialId: input.libraryMaterialId ?? null,
    storagePath: input.storagePath ?? null,
    materialsUrl: input.materialsUrl ?? null,
  };
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "materials_send",
    status: "queued",
    metadata,
  });
}
export type MaterialsSendMetadata = {
  // Null on rows written by the manual send paths, and on every row written
  // before this field existed — treat absence as "not deduped", never as a
  // material id that failed to match.
  libraryMaterialId?: string | null;
  storagePath: string | null;
  materialsUrl: string | null;
};

// Library material assigned to a student's account (not a class). The
// class-materials path (materials_send) only fires for booking-scoped
// attachments; this is its account-level counterpart, sent when a teacher
// assigns a level-library item to a student. Student-recipient, push with
// email fallback. libraryMaterialId lives in metadata so the dispatcher resolves the
// material's label at send time.
export async function enqueueLibraryMaterialAssigned(
  tx: Tx,
  input: { teacherId: string; studentId: string; libraryMaterialId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    channel: "email",
    templateName: "library_material_assigned",
    status: "queued",
    metadata: {
      libraryMaterialId: input.libraryMaterialId,
    } satisfies LibraryMaterialAssignedMetadata,
  });
}
export type LibraryMaterialAssignedMetadata = { libraryMaterialId: string };

// ---------------------------------------------------------------------------
// Slice "audit P1+P2" (2026-05-27): silent-state producers.
// ---------------------------------------------------------------------------
// Student-recipient producers in this batch route push → email;
// teacher-recipient producers are email-only.

export async function enqueuePaymentFailedStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "payment_failed_student",
    status: "queued",
  });
}

export async function enqueueRefundIssuedStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "refund_issued_student",
    status: "queued",
  });
}

export async function enqueueRefundIssuedTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "refund_issued_teacher",
    status: "queued",
  });
}

// Lost chargeback. Separate producers from the refund pair on purpose — the
// templates say different things, and conflating them would tell a student her
// money went back when it did not.
export async function enqueueDisputeLostStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "dispute_lost_student",
    status: "queued",
  });
}

export async function enqueueDisputeLostTeacher(
  tx: Tx,
  input: { teacherId: string; paymentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    paymentId: input.paymentId,
    channel: "email",
    templateName: "dispute_lost_teacher",
    status: "queued",
  });
}

export async function enqueueStripeReadyTeacher(
  tx: Tx,
  input: { teacherId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "stripe_ready_teacher",
    status: "queued",
  });
}

export async function enqueueStripeRequirementsTeacher(
  tx: Tx,
  input: { teacherId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "stripe_requirements_teacher",
    status: "queued",
  });
}

export async function enqueueAccountDisabledTeacher(
  tx: Tx,
  input: { teacherId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "account_disabled_teacher",
    status: "queued",
  });
}

export async function enqueueBookingCreatedTeacher(
  tx: Tx,
  input: { teacherId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "booking_created_teacher",
    status: "queued",
  });
}

// Student submitted homework for one of the teacher's classes. Teacher-recipient
// (channel starts at push; the dispatcher picks push-or-email). `assignmentTitle`
// rides in metadata so the dispatcher renders "… submitted <title>" without a
// second join; `bookingId` deep-links to that class's detail page.
export async function enqueueHomeworkSubmitted(
  tx: Tx,
  input: { teacherId: string; bookingId: string; assignmentTitle: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "homework_submitted_teacher",
    status: "queued",
    metadata: { assignmentTitle: input.assignmentTitle } satisfies HomeworkSubmittedMetadata,
  });
}
export type HomeworkSubmittedMetadata = { assignmentTitle: string };

// An Assignment was created for one of the student's classes (manual or
// auto-drafted from a [!homework]/[!exercise] material callout,
// docs/features/homework.md). Student-recipient, push-first
// like the rest of this file's producers.
export async function enqueueHomeworkAssigned(
  tx: Tx,
  input: { studentId: string; teacherId: string; bookingId: string; assignmentTitle: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "homework_assigned_student",
    status: "queued",
    metadata: { assignmentTitle: input.assignmentTitle } satisfies HomeworkAssignedMetadata,
  });
}
export type HomeworkAssignedMetadata = { assignmentTitle: string };

// A teacher created HomeworkFeedback for the student's latest attempt — the
// payoff of the whole review workflow. One template covers all three
// decisions; `decision` rides in metadata so the dispatcher/copy can branch.
export async function enqueueHomeworkFeedbackAvailable(
  tx: Tx,
  input: {
    studentId: string;
    teacherId: string;
    bookingId: string;
    assignmentTitle: string;
    decision: "approved" | "resubmission_requested" | "rejected";
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "homework_feedback_available_student",
    status: "queued",
    metadata: {
      assignmentTitle: input.assignmentTitle,
      decision: input.decision,
    } satisfies HomeworkFeedbackAvailableMetadata,
  });
}
export type HomeworkFeedbackAvailableMetadata = {
  assignmentTitle: string;
  decision: "approved" | "resubmission_requested" | "rejected";
};

// Due-soon reminder (docs/features/homework.md): a fixed
// window before an assignment's dueAt, for a student who hasn't submitted
// yet. Only assignmentId lives in metadata — the dispatcher resolves the
// title/dueAt fresh at send time (same "just the id, look up the rest at
// render" pattern as enqueuePackageExpiryNudge) so the copy always reflects
// the current assignment and dueAt is formatted in the recipient's own
// timezone/locale, not the cron's. Dedup (one nudge per assignment) is
// enforced by the cron.
export async function enqueueHomeworkDueSoon(
  tx: Tx,
  input: { studentId: string; teacherId: string; bookingId: string; assignmentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "homework_due_soon_student",
    status: "queued",
    metadata: { assignmentId: input.assignmentId } satisfies HomeworkDueSoonMetadata,
  });
}
export type HomeworkDueSoonMetadata = { assignmentId: string };

// Overdue reminder (docs/features/homework.md): fired once
// after dueAt has passed with no submission — regardless of
// allowLateSubmission (surfacing the miss, not gating it). Dedup (one nudge
// per assignment) is enforced by the cron.
export async function enqueueHomeworkOverdue(
  tx: Tx,
  input: { studentId: string; teacherId: string; bookingId: string; assignmentId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "push",
    templateName: "homework_overdue_student",
    status: "queued",
    metadata: { assignmentId: input.assignmentId } satisfies HomeworkOverdueMetadata,
  });
}
export type HomeworkOverdueMetadata = { assignmentId: string };

export async function enqueueCancelLt24hTeacher(
  tx: Tx,
  input: { teacherId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "cancel_lt24h_teacher",
    status: "queued",
  });
}

export async function enqueueCancelGte24hTeacher(
  tx: Tx,
  input: { teacherId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "cancel_gte24h_teacher",
    status: "queued",
  });
}

export async function enqueueRescheduleConfirmTeacher(
  tx: Tx,
  input: {
    teacherId: string;
    bookingId: string;
    oldScheduledStart: Date;
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "reschedule_confirm_teacher",
    status: "queued",
    metadata: {
      oldScheduledStart: input.oldScheduledStart.toISOString(),
    } satisfies RescheduleConfirmMetadata,
  });
}

export async function enqueueNoShowStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; bookingId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    bookingId: input.bookingId,
    channel: "email",
    templateName: "no_show_student",
    status: "queued",
  });
}

// Pre-expiry nudge: one-time reminder that a package with unused classes is
// about to expire, so the student books before they lapse. Student-recipient,
// push with email fallback. The packageId lives in metadata so the dispatcher can resolve the
// package name, remaining classes, and expiry date at send time. Dedup
// (one nudge per package) is enforced by the cron, not a DB constraint.
export async function enqueuePackageExpiryNudge(
  tx: Tx,
  input: { teacherId: string; studentId: string; packageId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    channel: "email",
    templateName: "package_expiry_nudge",
    status: "queued",
    metadata: { packageId: input.packageId } satisfies PackageExpiryNudgeMetadata,
  });
}
export type PackageExpiryNudgeMetadata = { packageId: string };

// Consumed-package renewal nudge: the student booked the last
// class of their package and there's no newer one — the single moment the
// "buy again" model depends on. Student-recipient, push with email fallback.
// Dedup (one nudge per package) is enforced by the cron via the teacher row's metadata.
export async function enqueuePackageConsumedStudent(
  tx: Tx,
  input: { teacherId: string; studentId: string; packageId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    channel: "email",
    templateName: "package_consumed_student",
    status: "queued",
    metadata: { packageId: input.packageId } satisfies PackageConsumedMetadata,
  });
}

// Teacher mirror of the consumed-package nudge — a repeat-purchase
// opportunity she can chase personally. Always enqueued by the
// sweep (also when the student variant is suppressed by preferences), so
// it doubles as the dedup anchor: one teacher row per package, ever.
export async function enqueuePackageConsumedTeacher(
  tx: Tx,
  input: {
    teacherId: string;
    studentId: string;
    packageId: string;
    // Whether the student's own renewal notice was enqueued (their
    // `expiry_reminders` category is on). Carried into the teacher email so it
    // only claims "we told them" when a student notice actually went out.
    studentNotified: boolean;
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "package_consumed_teacher",
    status: "queued",
    metadata: {
      packageId: input.packageId,
      studentId: input.studentId,
      studentNotified: input.studentNotified,
    } satisfies PackageConsumedTeacherMetadata,
  });
}
export type PackageConsumedMetadata = { packageId: string };
export type PackageConsumedTeacherMetadata = {
  packageId: string;
  studentId: string;
  studentNotified: boolean;
};

// ---------------------------------------------------------------------------
// Subscription / monetization (docs/features/subscriptions.md). All teacher-recipient,
// email-primary. Display values are computed at enqueue time and carried in
// metadata so the dispatcher doesn't need a subscription join.
// ---------------------------------------------------------------------------

export type SubscriptionNotificationMetadata = {
  daysRemaining?: number;
  amountMinorUnits?: number;
  // ISO-4217 currency the `amountMinorUnits` above is denominated in, recorded
  // at enqueue time off the live Stripe object. The platform bills in GBP
  // since D-99 and billed a pre-D-99 subscriber in MXN, and neither figure may
  // be reinterpreted later — so the currency travels with the amount rather
  // than being re-derived at render time. Absent only on rows queued before
  // this field existed; the dispatcher falls back to the platform region's
  // currency, never to `formatMinorUnits`'s MXN default.
  currency?: string;
  // ISO string for the next charge date.
  nextChargeAt?: string;
  graceDays?: number;
};

export async function enqueueSubscriptionTrialEnding(
  tx: Tx,
  input: { teacherId: string; daysRemaining: number },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "subscription_trial_ending",
    status: "queued",
    metadata: { daysRemaining: input.daysRemaining } satisfies SubscriptionNotificationMetadata,
  });
}

export async function enqueueSubscriptionPaymentSucceeded(
  tx: Tx,
  input: {
    teacherId: string;
    amountMinorUnits: number;
    currency: string;
    nextChargeAt: Date | null;
  },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "subscription_payment_succeeded",
    status: "queued",
    metadata: {
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      nextChargeAt: input.nextChargeAt?.toISOString(),
    } satisfies SubscriptionNotificationMetadata,
  });
}

export async function enqueueSubscriptionPaymentFailed(
  tx: Tx,
  input: { teacherId: string; graceDays: number },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "subscription_payment_failed",
    status: "queued",
    metadata: { graceDays: input.graceDays } satisfies SubscriptionNotificationMetadata,
  });
}

export async function enqueueSubscriptionCanceled(
  tx: Tx,
  input: { teacherId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "subscription_canceled",
    status: "queued",
  });
}

export async function enqueueSubscriptionFoundingPriceLocked(
  tx: Tx,
  input: { teacherId: string; amountMinorUnits: number; currency: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "subscription_founding_price_locked",
    status: "queued",
    metadata: {
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
    } satisfies SubscriptionNotificationMetadata,
  });
}

// ---------------------------------------------------------------------------
// Chat message notifications (2026-06-29)
// ---------------------------------------------------------------------------
// Push-only with email fallback. `preview` is the
// first ~100 chars of the message body (text), or a short type label
// ("Voice message" / "Video") for media messages.
//
// `messageId` ties the notification back to its message row so delete-for-
// everyone can retract it (and edit can refresh the preview) in
// lib/chat/message-actions.ts, and so the delayed email fallback can skip a
// message that was deleted before it fired. Optional on read: rows enqueued
// before 2026-07-09 predate it.

export type ChatMessageMetadata = { preview: string; messageId: string };
export type ChatMessageTeacherMetadata = { preview: string; studentId: string; messageId: string };

// Teacher sends a message to a student — notify the student.
export async function enqueueChatMessage(
  tx: Tx,
  input: { teacherId: string; studentId: string; preview: string; messageId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "student",
    recipientId: input.studentId,
    channel: "email",
    templateName: "chat_message",
    status: "queued",
    metadata: { preview: input.preview, messageId: input.messageId } satisfies ChatMessageMetadata,
  });
}

// Student sends a message to a teacher — notify the teacher.
export async function enqueueChatMessageTeacher(
  tx: Tx,
  input: { teacherId: string; studentId: string; preview: string; messageId: string },
): Promise<string> {
  return insert(tx, {
    teacherId: input.teacherId,
    recipientType: "teacher",
    recipientId: input.teacherId,
    channel: "email",
    templateName: "chat_message_teacher",
    status: "queued",
    metadata: {
      preview: input.preview,
      studentId: input.studentId,
      messageId: input.messageId,
    } satisfies ChatMessageTeacherMetadata,
  });
}
