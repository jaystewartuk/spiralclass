import type { PrismaClient } from "@prisma/client";
import { StripeApiError } from "@/lib/stripe";
import { logger } from "@/lib/logger";
import { purgeTeacherRecordings } from "@/lib/account-deletion/purge-recordings";

const log = logger({ surface: "account-deletion" });

// docs/security.md.
//
// Pure anonymizer for matured account_deletion_requests rows. Split
// from the Inngest cron handler so tests can drive it with a fake
// Prisma client.
//
// Retention policy implemented here (see the student portal of the plan):
//   * Teacher: email/name/phone anonymized, payout details cleared,
//     `disabled_at` set so the account cannot serve traffic. The row
//     stays as an FK target for Payment / Override.
//   * Student: same on the Student row. Payments retain studentId but
//     all identifying columns on Student are nulled / anonymized.
//   * Notifications / push subscriptions: deleted.
//
// We do NOT delete the better-auth `user` identity row here. The plan
// keeps that as a separate manual step for the operator (it's a
// service-role action with auth-server-side consequences). The
// account is already non-functional after this runs.

export type AnonymizeDeps = {
  prisma: Pick<
    PrismaClient,
    | "accountDeletionRequest"
    | "teacher"
    | "teacherSubscription"
    | "student"
    | "webPushSubscription"
    | "notification"
    | "callRecording"
    | "lessonAudio"
    | "lessonTranscript"
    | "lessonSummary"
    | "$transaction"
  >;
  now: Date;
  // Optional Stripe Billing canceller. The cron handler injects a real one so a
  // deleted teacher stops being billed for Pro; tests omit it (pure-DB path).
  // Kept out of the DB transaction — it's an external call.
  cancelStripeSubscription?: (stripeSubscriptionId: string) => Promise<void>;
  // Optional better-auth session revoker. The cron handler injects a real one
  // so a deleted account's live sessions are hard-revoked globally (otherwise an
  // already-issued cookie keeps working until it expires). Best-effort and
  // outside the DB transaction — same shape as cancelStripeSubscription.
  revokeAuthSessions?: (authUserId: string) => Promise<void>;
  // Optional "does this subject still hold paid, active class credits?" check.
  // The request-time actions block deletion on this, but the account stays live
  // through the 30-day grace window, so a package sold DURING the window would
  // otherwise be tombstoned with unused paid classes. Injected so the sweep can
  // re-check at maturity and defer instead. The cron handler wires the real
  // teacher/student package checks.
  hasUnusedActivePackages?: (
    subjectType: "teacher" | "student",
    subjectId: string,
  ) => Promise<boolean>;
  // Destroys the teacher's class recordings, insights audio, transcripts and
  // summaries — the R2 objects as well as the rows (D-136). Injectable so the
  // pure-DB tests here don't reach for storage; defaults to the real purge.
  purgeRecordings?: (teacherId: string) => Promise<unknown>;
};

// A maturity re-check that finds money still in play pushes the request out
// by this long rather than tombstoning it, so the sweep revisits later (and
// doesn't re-pick the same row every run).
export const DELETION_DEFER_MS = 7 * 24 * 60 * 60 * 1000;

export type AnonymizeResult = {
  processed: number;
  teachersAnonymized: number;
  studentsAnonymized: number;
  // Requests left pending because the subject still holds unused paid classes
  // (money in play). Surfaced so ops can resolve (refund / let classes run).
  deferred: number;
  // Requests whose atomic claim failed (a cancel landed first, so the row was
  // no longer pending). Left untouched.
  skipped: number;
  errors: Array<{ requestId: string; reason: string }>;
};

export async function anonymizeMaturedDeletions(deps: AnonymizeDeps): Promise<AnonymizeResult> {
  const matured = await deps.prisma.accountDeletionRequest.findMany({
    where: {
      status: "pending",
      scheduledFor: { lte: deps.now },
    },
    take: 50,
  });

  const result: AnonymizeResult = {
    processed: matured.length,
    teachersAnonymized: 0,
    studentsAnonymized: 0,
    deferred: 0,
    skipped: 0,
    errors: [],
  };

  for (const req of matured) {
    try {
      const subjectType = req.subjectType === "teacher" ? "teacher" : "student";
      // Atomically claim the row BEFORE any destructive work. The batch takes
      // minutes (Stripe + Supabase per row), and "cancel deletion" flips
      // pending -> cancelled with no coordination. Without this claim the sweep
      // would anonymize an already-scanned row and clobber the user's cancel to
      // 'anonymized'. Guarded pending -> anonymizing: if a cancel already
      // landed, count === 0 and we skip.
      const claim = await deps.prisma.accountDeletionRequest.updateMany({
        where: { id: req.id, status: "pending" },
        data: { status: "anonymizing" },
      });
      if (claim.count === 0) {
        result.skipped += 1;
        continue;
      }

      // Re-check at maturity: the guard the request action ran can be stale by
      // now — the account was live for the whole grace window, so a package
      // could have been sold (real MXN) after the request was filed. Never
      // tombstone a subject whose paid classes are still unused; defer instead
      // and surface it for ops to resolve. Release the claim back to pending so
      // the deferred row is revisited.
      if (
        deps.hasUnusedActivePackages &&
        (await deps.hasUnusedActivePackages(subjectType, req.subjectId))
      ) {
        await deps.prisma.accountDeletionRequest.update({
          where: { id: req.id },
          data: {
            status: "pending",
            scheduledFor: new Date(deps.now.getTime() + DELETION_DEFER_MS),
          },
        });
        result.deferred += 1;
        log.warn("deletion deferred: subject still holds unused paid classes", {
          requestId: req.id,
          subjectType,
          subjectId: req.subjectId,
        });
        continue;
      }

      if (req.subjectType === "teacher") {
        await anonymizeTeacher(deps, req.subjectId);
        result.teachersAnonymized += 1;
      } else {
        await anonymizeStudent(deps, req.subjectId);
        result.studentsAnonymized += 1;
      }
      await deps.prisma.accountDeletionRequest.update({
        where: { id: req.id },
        data: { status: "anonymized", anonymizedAt: deps.now },
      });
    } catch (err) {
      result.errors.push({
        requestId: req.id,
        reason: err instanceof Error ? err.message : "unknown",
      });
      // Release the claim so the daily retry (which selects status='pending')
      // can pick this row up again. Best-effort: leave it claimed if even this
      // fails — an operator can reset it, and it beats an infinite retry loop.
      try {
        await deps.prisma.accountDeletionRequest.updateMany({
          where: { id: req.id, status: "anonymizing" },
          data: { status: "pending" },
        });
      } catch (releaseErr) {
        log.error("failed to release deletion claim after error", releaseErr, {
          requestId: req.id,
        });
      }
    }
  }

  return result;
}

async function anonymizeTeacher(deps: AnonymizeDeps, teacherId: string): Promise<void> {
  const tombstoneEmail = `deleted+${teacherId}@spiralclass.invalid`;

  // Cancel any live Stripe Billing subscription BEFORE tombstoning, so a
  // departing Pro teacher stops being charged. Comped subscriptions (e.g. Alicia
  // Moreno) have no Stripe subscription to cancel.
  const subscription = await deps.prisma.teacherSubscription.findUnique({
    where: { teacherId },
    select: { stripeSubscriptionId: true, comped: true, status: true },
  });
  // dropToFree (customer.subscription.deleted) flips status to "free" but never
  // clears stripeSubscriptionId, so every ex-Pro teacher keeps an id pointing
  // at an ALREADY-CANCELED Stripe subscription. Only attempt the cancel when
  // the local status says the sub is still live — otherwise the POST returns
  // 400 "cannot update a canceled subscription", which used to throw and abort
  // anonymization, leaving the deletion request pending forever (a permanent,
  // silent failure to honor an ARCO/GDPR request for a common class of users).
  const subIsLive =
    subscription?.status === "active" ||
    subscription?.status === "trialing" ||
    subscription?.status === "past_due";
  if (
    deps.cancelStripeSubscription &&
    subscription?.stripeSubscriptionId &&
    !subscription.comped &&
    subIsLive
  ) {
    try {
      await deps.cancelStripeSubscription(subscription.stripeSubscriptionId);
    } catch (err) {
      // Already-canceled / missing at Stripe (400/404) → nothing to do, treat
      // as success. Genuinely retryable errors (network, 429, 5xx) propagate
      // so the sweep retries rather than tombstoning while billing is unsure.
      if (err instanceof StripeApiError && (err.status === 400 || err.status === 404)) {
        log.warn("stripe sub already canceled/missing at deletion; continuing", {
          teacherId,
          stripeStatus: err.status,
        });
      } else {
        throw err;
      }
    }
  }

  await deps.prisma.$transaction(async (tx) => {
    await tx.teacher.update({
      where: { id: teacherId },
      data: {
        email: tombstoneEmail,
        name: "Cuenta eliminada",
        phoneE164: null,
        stripeAccountId: null,
        stripeAccountLinkedAt: null,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        wisePaymentsEnabled: false,
        wiseHandle: null,
        wiseAccountHolder: null,
        wiseEmail: null,
        disabledAt: deps.now,
        disabledReason: "account_deleted",
      },
    });
    // Browser push registrations. ⚠️ This deleted a retired token table
    // and NEVER this table, so every deletion request since web push shipped
    // left a live subscription — endpoint plus its encryption keys — behind.
    await tx.webPushSubscription.deleteMany({
      where: { recipientType: "teacher", recipientId: teacherId },
    });
    // Drop notifications targeted at this teacher. Notifications for
    // other recipients (e.g. teacher_id is platform-side scope on a
    // student-targeted notification) are kept — they're business
    // records linked to the booking / payment.
    await tx.notification.deleteMany({
      where: { recipientType: "teacher", recipientId: teacherId },
    });
  });

  // Destroy her recordings and everything derived from them (D-136). Outside
  // the transaction because it does network I/O against R2, and AFTER it because
  // a storage outage must not be able to block a deletion request the user has
  // already waited out the grace window for — a row whose object survives is
  // left in place for a human, and says so in the log.
  const purge = deps.purgeRecordings ?? ((id: string) => purgeTeacherRecordings(deps.prisma, id));
  try {
    await purge(teacherId);
  } catch (err) {
    // Genuinely best-effort: the account is already anonymised and unusable, and
    // the user has waited out a 30-day grace window. Throwing here would abort
    // the rest of anonymizeTeacher (the session revoke below) and re-surface as
    // a failed request, which is a worse outcome than a logged, retryable
    // leftover. purgeTeacherRecordings already logs its own partial failures;
    // this is for the case where it could not run at all.
    log.error("recording purge failed outright", err, { teacherId });
  }

  // Hard-revoke any live better-auth sessions. The teacher row id IS the auth
  // user id (see lib/auth.ts requireTeacher: `prisma.teacher.create({ id:
  // user.id })`). Best-effort and outside the transaction — the row is already
  // disabled if this throws, and the error surfaces to the caller's list.
  if (deps.revokeAuthSessions) {
    await deps.revokeAuthSessions(teacherId);
  }
}

async function anonymizeStudent(deps: AnonymizeDeps, studentId: string): Promise<void> {
  const tombstoneEmail = `deleted+${studentId}@spiralclass.invalid`;

  // Capture the auth link BEFORE the transaction nulls it, so we can revoke
  // the student's live better-auth sessions afterwards. Read the primitive out
  // now (don't hold the row reference) so it survives the update below.
  const before = await deps.prisma.student.findUnique({
    where: { id: studentId },
    select: { authUserId: true },
  });
  const authUserId = before?.authUserId ?? null;

  await deps.prisma.$transaction(async (tx) => {
    await tx.student.update({
      where: { id: studentId },
      data: {
        email: tombstoneEmail,
        name: "Cuenta eliminada",
        phoneE164: null,
        emailOptIn: false,
        // Sever the better-auth link so a re-sign-in cannot rejoin
        // this row. The `user` identity row itself is deleted manually by
        // an operator (the runbook in INCIDENT_RESPONSE.md is the
        // template — we leave the auth purge as a deliberate step).
        authUserId: null,
        disabledAt: deps.now,
        disabledReason: "account_deleted",
      },
    });
    await tx.webPushSubscription.deleteMany({
      where: { recipientType: "student", recipientId: studentId },
    });
    await tx.notification.deleteMany({
      where: { recipientType: "student", recipientId: studentId },
    });
    // Contact-change audit rows carry pre-edit emails/numbers in their
    // before/after JSON — tombstoning the student row isn't enough.
    await tx.studentContactChange.deleteMany({ where: { studentId } });
    // Teacher-private notes are free text that may name the student — erasure
    // removes them rather than leaving them keyed to the tombstoned row.
    await tx.studentNote.deleteMany({ where: { studentId } });
  });

  // Hard-revoke any live better-auth sessions for the now-severed auth user.
  // Best-effort and outside the transaction (mirrors the teacher path).
  if (deps.revokeAuthSessions && authUserId) {
    await deps.revokeAuthSessions(authUserId);
  }
}
