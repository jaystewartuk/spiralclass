import {
  dispatchNotification,
  sendChatEmailFallbackIfUnread,
} from "@/lib/notifications/dispatcher";
import { makeDeps } from "@/lib/inngest/functions/dispatch-notification";
import { onMaterialPodcastRequestedHandler } from "@/lib/inngest/functions/on-material-podcast-requested";
import { adminReseedPreviewHandler } from "@/lib/inngest/functions/admin-reseed-preview";
import { grantReferralRewardHandler } from "@/lib/inngest/functions/grant-referral-reward";
import { magicLinkOnFirstPaymentHandler } from "@/lib/inngest/functions/magic-link-on-first-payment";
import { prisma } from "@/lib/prisma";
import { autoBookIntendedSlot } from "@/lib/booking/auto-book-intended";
import type { BookingEventEmitter } from "@/lib/booking/book-package-slot";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { scanAndScheduleNextWake } from "@/lib/notifications/reminder-scan";
import { enqueue } from "./enqueue";
import { inngest } from "@/lib/inngest/client";
import { getBoss } from "./boss";
import type { JobDefinition } from "./register";

// Phase 2a of the Inngest → in-house migration
// (docs/architecture/overview.md): the LIVE event handlers, as pg-boss queue
// definitions. Queue name = the Inngest event name, so producers routed through
// the enqueue() seam land here unchanged. Each handler calls the SAME
// underlying logic its Inngest function runs.
//
// SCOPE: notifications + podcast + admin-reseed. The four dormant AI handlers
// (lesson-audio/transcript/insights/intro-video) are intentionally NOT ported
// yet — they're flag-gated OFF (legal/consent-blocked, D-19/D-21/D-22; intro
// coach dormant), their producers still emit to Inngest, and Inngest still
// serves them until a later phase. Mixed routing per event-type is safe: every
// handler is idempotent and the flag only decides which backend each converted
// producer targets.
//
// These run ONLY when JOBS_BACKEND=pgboss (the worker boots). Until the flip,
// the enqueue() seam routes producers to inngest.send exactly as before.

// pg-boss delivers a batch array; default batch size is 1. Chat templates whose
// push succeeded get an email fallback after a grace window — modeled as a
// delayed pg-boss job (startAfter) rather than the Inngest handler's in-run
// step.sleep. 180s mirrors dispatch-notification.ts's CHAT_EMAIL_FALLBACK_GRACE.
const CHAT_EMAIL_FALLBACK_GRACE_SECONDS = 180;
const CHAT_FALLBACK_QUEUE = "notification.chat-email-fallback";

// Same structural step runner the extracted Inngest handlers accept; no long
// sleep in podcast/reseed, so invoking the fn directly is exact.
const stepShim = { run: <T>(_id: string, fn: () => T | Promise<T>) => Promise.resolve(fn()) };

// Phase 2b (money fan-out). One `payment.paid` maps to three independent,
// idempotent consumers. Inngest fans out by having three functions subscribe to
// the same event, each with its own retry budget; pg-boss is one-handler-per-
// queue, so the `payment.paid` queue is a fan-out that enqueues three child
// jobs, each on its own queue with the SAME retry budget its Inngest function
// used. Independent retries + isolation are preserved (a stuck referral never
// re-runs auto-book). Every consumer is idempotent (auto-book once the credit
// is spent, referral/magic-link dedupe), and reconcile-paid-payments-cron
// remains the backstop for a lost `payment.paid` — so re-enqueueing on a
// fan-out retry is safe.
//
// There is no payout consumer here. Under direct charges the student's money
// is never on the platform balance to move: it settles on the teacher's own
// connected account. The `payment.paid.transfer` child queue died with
// separate charges and transfers (D-143).
type PaidData = { paymentId: string; packageId: string; teacherId: string; studentId: string };

const PAID_CHILD = {
  autoBook: "payment.paid.auto-book",
  referral: "payment.paid.referral",
  magicLink: "payment.paid.magic-link",
} as const;

// Retry budgets copied verbatim from each Inngest function's `retries`.
const PAID_RETRIES = { autoBook: 3, referral: 2, magicLink: 2 } as const;

async function fanOutPaymentPaid(data: PaidData): Promise<void> {
  const boss = await getBoss();
  await Promise.all([
    boss.send(PAID_CHILD.autoBook, data, { retryLimit: PAID_RETRIES.autoBook, retryBackoff: true }),
    boss.send(PAID_CHILD.referral, data, { retryLimit: PAID_RETRIES.referral, retryBackoff: true }),
    boss.send(PAID_CHILD.magicLink, data, {
      retryLimit: PAID_RETRIES.magicLink,
      retryBackoff: true,
    }),
  ]);
}

// Auto-book emits downstream events. Mirrors the Inngest auto-book wrapper
// exactly: notification.queued goes through the best-effort emitNotificationQueued
// (seam-routed since Phase 2a); booking.created stays on inngest.send because it
// has no pg-boss handler until Phase 2b-ii (reminders→cron-scan). Inngest still
// serves booking.created, so this cross-backend hop is safe and idempotent.
const bookingEmitViaSeam: BookingEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send(event);
  }
};

async function handleNotificationQueued(data: { notificationId: string }): Promise<void> {
  const deps = makeDeps();
  const outcome = await dispatchNotification(data.notificationId, deps);

  // Chat push→email cascade (D-44): the dispatcher pushed a chat message and
  // skipped email because the recipient has the app. Wait out the grace window
  // as a delayed job, then email only if they still haven't opened the thread.
  if (
    outcome.code === "sent" &&
    outcome.channel === "push" &&
    (outcome.templateName === "chat_message" || outcome.templateName === "chat_message_teacher")
  ) {
    await (
      await getBoss()
    ).send(
      CHAT_FALLBACK_QUEUE,
      { notificationId: data.notificationId },
      { startAfter: CHAT_EMAIL_FALLBACK_GRACE_SECONDS },
    );
  }
}

export const eventJobs: JobDefinition[] = [
  {
    queue: "notification.queued",
    handler: async (jobs) => {
      for (const job of jobs) {
        await handleNotificationQueued(job.data as { notificationId: string });
      }
    },
  },
  {
    // pg-boss-only follow-up queue for the chat email-if-unread grace window
    // (the Inngest path does this inline via step.sleep). Enqueued with
    // startAfter by handleNotificationQueued above.
    queue: CHAT_FALLBACK_QUEUE,
    handler: async (jobs) => {
      for (const job of jobs) {
        const { notificationId } = job.data as { notificationId: string };
        await sendChatEmailFallbackIfUnread(notificationId, makeDeps());
      }
    },
  },
  {
    // The reminder wake chain's delivery end (D-115) — a delayed job armed by
    // reminder-scan-cron at the exact moment the next reminder leg comes due,
    // so the hourly grid still serves the 15m leg exactly. Re-runs the whole
    // scan (it carries no booking identity on purpose) and arms the next wake.
    queue: "reminder.due",
    // Ignores the batch: the scan is global, not per-job, so several wakes
    // delivered together collapse into one run rather than N identical scans.
    handler: async () => {
      await scanAndScheduleNextWake({ prisma, enqueue });
    },
  },
  {
    queue: "material.podcast.requested",
    handler: async (jobs) => {
      for (const job of jobs) {
        await onMaterialPodcastRequestedHandler({
          event: { data: job.data as never },
          step: stepShim,
        });
      }
    },
  },
  {
    queue: "admin/uat.reseed-preview",
    handler: async (jobs) => {
      for (const job of jobs) {
        await adminReseedPreviewHandler({
          event: { data: job.data },
          step: stepShim,
        });
      }
    },
  },
  // ── payment.paid fan-out (Phase 2b) ──────────────────────────────────────
  {
    queue: "payment.paid",
    handler: async (jobs) => {
      for (const job of jobs) {
        await fanOutPaymentPaid(job.data as PaidData);
      }
    },
  },
  {
    queue: PAID_CHILD.autoBook,
    handler: async (jobs) => {
      for (const job of jobs) {
        const { packageId } = job.data as PaidData;
        await autoBookIntendedSlot({ prisma, emit: bookingEmitViaSeam }, packageId);
      }
    },
  },
  {
    queue: PAID_CHILD.referral,
    handler: async (jobs) => {
      for (const job of jobs) {
        await grantReferralRewardHandler({ event: { data: job.data }, step: stepShim });
      }
    },
  },
  {
    queue: PAID_CHILD.magicLink,
    handler: async (jobs) => {
      for (const job of jobs) {
        await magicLinkOnFirstPaymentHandler({ event: { data: job.data }, step: stepShim });
      }
    },
  },
];
