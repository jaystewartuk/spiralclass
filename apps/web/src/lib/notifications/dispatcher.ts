import type { Notification, Prisma, PrismaClient } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import type { StorageProvider } from "@/lib/storage/provider";
import { logger } from "@/lib/logger";
import { trackServerEvent, flushAnalytics } from "@/lib/analytics/posthog";
import type { EmailClient } from "@/lib/email";
import { mintMaterialsSignedUrl } from "@/lib/storage/signed-urls";
import {
  isTeacherRecipientTemplate,
  localeToLanguageCode,
  TEMPLATE_NAMES,
  urlButtonSuffix,
  type LanguageCode,
  type TemplateName,
  type TemplateVariables,
} from "./templates";
import { renderEmail } from "@/lib/email/templates";
import { buildGoogleCalendarUrl } from "@/lib/calendar/add-to-calendar";
import { signEmailOptOutToken } from "@/lib/email/opt-out-token";
import { signNotificationSettingsToken } from "./settings-link-token";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { getVideoProvider } from "@/lib/video/provider";
import { formatMinorUnits } from "@/lib/money";
import { currencyForRegion } from "@spiralclass/shared";
import { SUPPORT_EMAIL } from "@/lib/support";
import { formatDateTimeInZone } from "@/lib/tz";

// Dual-timezone class-time copy: every CLASS date/time notification (booking
// confirmed/reminded/rescheduled/canceled) shows the recipient's own local
// time first, then the other participant's local time, labeled by name —
// see the dual-timezone-display feature. Appended as " · Name: <time>" so it
// drops into the existing mid-sentence `${classDateTime}` interpolations
// (email/push/in-app copy) without changing their surrounding prose. Always
// appends the secondary segment, even when both zones match, per spec (keeps
// the label/behavior consistent regardless of where the two people are).
function formatClassDateTime(
  d: Date,
  primaryTz: string,
  locale: string,
  otherTz: string,
  otherLabel: string,
): string {
  const primary = formatDateTimeInZone(d, primaryTz, locale);
  const other = otherTz === primaryTz ? primary : formatDateTimeInZone(d, otherTz, locale);
  return `${primary} · ${otherLabel}: ${other}`;
}
import { resolveChannels, type Recipient } from "./resolve-channel";
import {
  coerceTeacherNotificationPrefs,
  getAllowedChannels,
  isCategoryEnabled,
  isTransactionalTemplate,
  teacherTemplateCategory,
  templateCategory,
  type NotificationPrefs,
  type TeacherNotificationPrefs,
} from "./preferences";
import { pushChannelForTemplate, renderPush } from "./push";
import {
  getWebPushClient,
  isWebPushConfigured,
  type WebPushClient,
  type WebPushSubscriptionRecord,
} from "./web-push";
import { webPathForDeepLink } from "./web-deep-links";
import type {
  ChatMessageMetadata,
  ChatMessageTeacherMetadata,
  HomeworkDueSoonMetadata,
  HomeworkOverdueMetadata,
  LibraryMaterialAssignedMetadata,
  MagicLinkMetadata,
  MaterialsSendMetadata,
  PackageConsumedMetadata,
  PackageConsumedTeacherMetadata,
  PackageExpiryNudgeMetadata,
  PaymentReceivedMetadata,
  RescheduleConfirmMetadata,
  SubscriptionNotificationMetadata,
} from "./enqueue";

// Dispatcher core. Triggered per-row from Inngest's `notification.queued`
// handler. All side effects happen against a single notification row that
// the caller resolves by id.
//
// Delivery: channels are attempted in order (push → email). Most templates
// deliver push-FIRST — a successful push stops the cascade so a single event
// never buzzes both a push and an identical email; email is the fallback for
// when push can't land (no token / rejected). Record-of-truth templates
// (sign-in, money-of-record receipts) fan out to every eligible channel
// instead — see deliversPushFirst. The first delivered channel's
// providerMessageId is stored as the primary on the notification row;
// additional channels are recorded in metadata.channelsSent. Retryable failures
// throw immediately so Inngest retries; non-retryable failures are logged and
// the remaining channels continue. Already-sent channels (from a prior retry
// attempt) are skipped via metadata.channelsSent for idempotency.
//
// Hard rules: this runs with service-role-equivalent access from
// Inngest, so every Prisma query MUST filter by teacher_id. The notification
// row itself carries teacher_id; we propagate it into every join.

const log = logger({ surface: "dispatcher" });

export type DispatchOutcome =
  | { code: "noop"; reason: "not-queued" | "claim-lost" | "preference-disabled" }
  | {
      code: "sent";
      channel: "push" | "email";
      providerMessageId: string;
      templateName?: TemplateName;
    }
  | { code: "failed"; reason: string };

// Chat notifications deliver push-FIRST rather than fanning out to every
// channel: if the recipient has the app we push and stop, and a delayed job
// (sendChatEmailFallbackIfUnread, scheduled by the Inngest dispatch fn) emails
// later only if they never opened the thread. This keeps a single message from
// buzzing both a push and an email at once.
function isChatCascadeTemplate(name: string): name is "chat_message" | "chat_message_teacher" {
  return name === "chat_message" || name === "chat_message_teacher";
}

// Delivery strategy per template.
//
//   push-first (cascade): if the recipient has the app we push and STOP — email
//     is only a fallback for when push can't land (no device token, or a
//     rejected token). This is the default for suppressible lifecycle/nudge
//     notices (reminders, booking updates, materials, expiry nudges, chat,
//     growth). It's what stops a single event from buzzing both a push and an
//     email with identical content.
//
//   fan-out: push AND email both deliver. Reserved for record-of-truth notices —
//     sign-in links (you may be signing in on desktop while your phone has the
//     app) and money-of-record / security / billing-critical receipts, where a
//     durable copy in the inbox is worth the second buzz and the sends are
//     infrequent enough not to be noise.
//
// The line is exactly the suppressibility line already encoded in preferences:
// a template that carries a gateable preference category is a lifecycle nudge
// (cascade); one that carries no category (transactional / money-of-record /
// billing-critical) is a record-of-truth (fan-out). Chat is a cascade template
// that ADDITIONALLY schedules a delayed email-if-unread — see isChatCascadeTemplate.
function deliversPushFirst(templateName: TemplateName, isTeacherRecipient: boolean): boolean {
  if (isTransactionalTemplate(templateName)) return false; // magic-link: always email
  const category = isTeacherRecipient
    ? teacherTemplateCategory(templateName)
    : templateCategory(templateName);
  return category !== null;
}

export type DispatcherDeps = {
  prisma: PrismaClient;
  // The `push` channel's only transport. Optional so a caller or test
  // can omit it; when absent or null the channel is unavailable and the
  // cascade falls straight through to email.
  webPush?: WebPushClient | null;
  email: EmailClient;
  appUrl: string;
  // Storage provider used to mint short-lived signed URLs for class-materials
  // downloads on send. Optional so tests + stub paths run without one — when
  // null the dispatcher falls back to the legacy materialsUrl in
  // notification.metadata.
  storage?: StorageProvider | null;
  now?: () => Date;
  // HMAC secret for the email-unsubscribe URL footer.
  sessionSecret?: string;
};

// Null when VAPID isn't configured, so an unconfigured deploy skips the
// transport entirely instead of failing sends that email can still serve.
export function getDefaultDispatcherWebPushClient(): WebPushClient | null {
  return isWebPushConfigured() ? getWebPushClient() : null;
}

export async function dispatchNotification(
  notificationId: string,
  deps: DispatcherDeps,
): Promise<DispatchOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const notification = await deps.prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) {
    return { code: "failed", reason: `notification not found: ${notificationId}` };
  }
  if (notification.status !== "queued") {
    return { code: "noop", reason: "not-queued" };
  }
  // Atomically claim the row (queued → sending) so a concurrent or retried
  // dispatch of the same id can't double-send: only the worker that wins the
  // flip proceeds. On a thrown (retryable) failure we release the claim back to
  // queued so the Inngest retry re-processes; the terminal markFailed/markSent
  // writers overwrite `sending` on the permanent-failure / happy paths.
  const claim = await deps.prisma.notification.updateMany({
    where: { id: notification.id, status: "queued" },
    data: { status: "sending" },
  });
  if (claim.count === 0) {
    return { code: "noop", reason: "claim-lost" };
  }
  try {
    return await runClaimedDispatch(notification, now, deps);
  } catch (err) {
    await deps.prisma.notification.updateMany({
      where: { id: notification.id, status: "sending" },
      data: { status: "queued" },
    });
    throw err;
  }
}

async function runClaimedDispatch(
  notification: Notification,
  now: Date,
  deps: DispatcherDeps,
): Promise<DispatchOutcome> {
  if (!isKnownTemplate(notification.templateName)) {
    return await markFailed(
      deps.prisma,
      notification.id,
      now,
      `unknown-template:${notification.templateName}`,
    );
  }
  const templateName = notification.templateName as TemplateName;

  const teacher = await deps.prisma.teacher.findFirst({
    where: { id: notification.teacherId },
    select: {
      id: true,
      name: true,
      email: true,
      timezone: true,
      locale: true,
      // Teacher lifecycle preferences — gated below for teacher-recipient
      // templates that carry a suppressible category. Null = all on.
      notificationPrefs: true,
      // Channel opt-ins — mirrors the student fields, read from the DB so the
      // teacher can configure them from settings.
      pushOptIn: true,
      emailOptIn: true,
    },
  });
  if (!teacher) {
    return await markFailed(deps.prisma, notification.id, now, "teacher-not-found");
  }

  // Two recipient shapes:
  //   * student — full channel cascade (push → email)
  //   * teacher — the teacher receives
  //               operational alerts about their own business (Wise
  //               payments pending, student claims to have sent), so we
  //               don't apply the email opt-out check and don't render
  //               an unsubscribe footer. Push is allowed when the
  //               teacher has a registered device token.
  const isTeacherRecipient =
    notification.recipientType === "teacher" &&
    isTeacherRecipientTemplate(templateName) &&
    notification.recipientId === notification.teacherId;
  if (notification.recipientType !== "student" && !isTeacherRecipient) {
    return await markFailed(
      deps.prisma,
      notification.id,
      now,
      `unsupported-recipient-type:${notification.recipientType}`,
    );
  }

  let recipient: Recipient;
  let recipientEmail: string | null;
  let recipientId: string;
  let languageCode: LanguageCode;
  // The zone/locale every date in this notification's copy is rendered in —
  // the actual RECIPIENT's, not always the teacher's (a student recipient
  // must see her own local time, not her teacher's — see buildVariables).
  let recipientTimezone: string;
  let recipientLocale: string;
  let suppressUnsubscribeFooter = false;
  // Browser Web Push subscriptions for the recipient — the `push` channel's
  // only transport.
  let webSubs: WebPushSubscriptionRecord[];
  // Stored subscriptions only make a recipient push-reachable if we can
  // actually send to them. On a deploy without a VAPID keypair (deps.webPush
  // null) they must NOT count, or every dispatch to a browser-only recipient
  // runs a doomed push attempt and stamps a misleading pushError on the row
  // before falling through to the email that was always the real channel.
  const webPushUsable = Boolean(deps.webPush);
  // True when the recipient student's link to this teacher is archived
  // ("dar de baja"). Used to suppress lifecycle sends below. Stays false for
  // teacher recipients.
  let recipientLinkArchived = false;
  // True when the recipient student is still on a silent-onboarding hold for
  // this teacher (staged on the roster before going live). Suppresses lifecycle
  // sends below, same as an archived link. Stays false for teacher recipients.
  let recipientLinkOnboardingHold = false;
  // Student lifecycle preferences (null for teacher recipients / funnel
  // students with no stored prefs → treated as all-on).
  let studentPrefs: NotificationPrefs | null = null;
  // Teacher lifecycle preferences (null for student recipients / teachers
  // who've never touched the toggles → treated as all-on).
  let teacherPrefs: TeacherNotificationPrefs | null = null;

  if (isTeacherRecipient) {
    if (!teacher.email) {
      return await markFailed(deps.prisma, notification.id, now, "teacher-email-missing");
    }
    recipientId = teacher.id;
    recipientEmail = teacher.email;
    languageCode = localeToLanguageCode(teacher.locale);
    recipientTimezone = teacher.timezone;
    recipientLocale = teacher.locale;
    suppressUnsubscribeFooter = true;
    teacherPrefs = teacher.notificationPrefs
      ? coerceTeacherNotificationPrefs(teacher.notificationPrefs)
      : null;
    // Skipped entirely when the transport isn't configured — otherwise every
    // dispatch on a VAPID-less deploy pays a query whose result can't be used.
    webSubs = webPushUsable
      ? await deps.prisma.webPushSubscription.findMany({
          where: {
            recipientType: "teacher",
            recipientId: teacher.id,
            revokedAt: null,
          },
          select: { id: true, endpoint: true, p256dh: true, auth: true },
        })
      : [];
    recipient = {
      email: teacher.email,
      emailOptIn: teacher.emailOptIn,
      pushOptIn: teacher.pushOptIn,
      hasActivePushTokens: webPushUsable && webSubs.length > 0,
    };
  } else {
    const student = await deps.prisma.student.findFirst({
      where: {
        id: notification.recipientId,
        teacherStudents: { some: { teacherId: notification.teacherId } },
      },
      select: {
        id: true,
        email: true,
        emailOptIn: true,
        pushOptIn: true,
        notificationPrefs: true,
        locale: true,
        name: true,
        timezone: true,
        // The (teacher, student) link itself, so we can read its archived
        // ("dar de baja") state. Scoped to this teacher — students can be on
        // multiple rosters and only this teacher's link decides suppression.
        teacherStudents: {
          where: { teacherId: notification.teacherId },
          select: { archivedAt: true, onboardingHoldAt: true },
        },
      },
    });
    if (!student) {
      return await markFailed(
        deps.prisma,
        notification.id,
        now,
        "student-not-found-or-not-on-teacher",
      );
    }
    recipientId = student.id;
    recipientEmail = student.email;
    recipientLinkArchived = student.teacherStudents[0]?.archivedAt != null;
    recipientLinkOnboardingHold = student.teacherStudents[0]?.onboardingHoldAt != null;
    languageCode = localeToLanguageCode(student.locale);
    // Student.timezone is optional (never force-captured) — fall back to the
    // teacher's zone, the same "unknown → teacher's zone" default the student
    // portal pages use (formatBothZones in date-display.ts).
    recipientTimezone = student.timezone ?? teacher.timezone;
    recipientLocale = student.locale;
    // Fan-out across the student's identity set. A subscription is registered
    // under whichever Student row the portal session resolved to (the one with
    // authUserId set), but a notification may target a sibling row (same
    // email, different teacher). Expanding to all non-moderated rows sharing
    // the same email ensures push reaches the browser regardless of which
    // teacher's row is the notification target.
    const tokenStudentIds = student.email
      ? await deps.prisma.student
          .findMany({
            where: { email: { equals: student.email, mode: "insensitive" }, disabledAt: null },
            select: { id: true },
          })
          .then((rows) => rows.map((r) => r.id))
      : [student.id];
    webSubs = webPushUsable
      ? await deps.prisma.webPushSubscription.findMany({
          where: {
            recipientType: "student",
            recipientId: { in: tokenStudentIds },
            revokedAt: null,
          },
          select: { id: true, endpoint: true, p256dh: true, auth: true },
        })
      : [];
    studentPrefs = (student.notificationPrefs ?? null) as NotificationPrefs | null;
    recipient = {
      email: student.email,
      emailOptIn: student.emailOptIn,
      pushOptIn: student.pushOptIn,
      hasActivePushTokens: webPushUsable && webSubs.length > 0,
    };
  }

  // Archived-pairing gate. When the teacher has archived this student ("dar de
  // baja"), drop every lifecycle send for the pairing — reminders, materials,
  // expiry nudges, anything added later — while still letting transactional
  // sends (magic-link sign-in) through so a reactivated student can log back
  // in. Centralizing here, at the same choke point as the preference gate,
  // means new notification types are covered automatically.
  if (
    notification.recipientType === "student" &&
    recipientLinkArchived &&
    !isTransactionalTemplate(templateName)
  ) {
    return await markSuppressed(deps.prisma, notification.id, now, "link-archived");
  }

  // Silent-onboarding gate. The teacher has staged this student on her roster
  // (and possibly recorded a mid-package balance and booked classes) before the
  // student knows the app exists — drop every lifecycle send until she "goes
  // live", while still letting transactional sign-in through. Same choke point
  // as the archived gate, so new notification types are covered automatically.
  if (
    notification.recipientType === "student" &&
    recipientLinkOnboardingHold &&
    !isTransactionalTemplate(templateName)
  ) {
    return await markSuppressed(deps.prisma, notification.id, now, "onboarding-hold");
  }

  // Student notification-preference gate. Transactional templates (sign-in)
  // always send; lifecycle templates are dropped when the student has that
  // category turned off (CSV-imported students are all-off). This is the
  // single choke point — it covers event-driven sends (reminders,
  // confirmations) and sweep-driven ones (expiry nudge) alike.
  if (notification.recipientType === "student" && !isTransactionalTemplate(templateName)) {
    const category = templateCategory(templateName);
    if (category && !isCategoryEnabled(studentPrefs, category)) {
      return await markSuppressed(
        deps.prisma,
        notification.id,
        now,
        `preference-disabled:${category}`,
      );
    }
  }

  // Teacher notification-preference gate. Mirrors the student gate above but
  // over the teacher category set: only SUPPRESSIBLE teacher notices carry a
  // category (teacherTemplateCategory). Money-of-record, security and
  // billing-critical teacher notices return null there, so they can never be
  // muted by a toggle — the single choke point that keeps a teacher from
  // accidentally silencing a payment-failed or account-disabled notice.
  if (isTeacherRecipient && !isTransactionalTemplate(templateName)) {
    const category = teacherTemplateCategory(templateName);
    if (category && !isCategoryEnabled(teacherPrefs, category)) {
      return await markSuppressed(
        deps.prisma,
        notification.id,
        now,
        `preference-disabled:${category}`,
      );
    }
  }

  // Build variables once — they're channel-agnostic.
  const built = await buildVariables(deps.prisma, {
    templateName,
    notification,
    teacherName: teacher.name,
    recipientTimezone,
    recipientLocale,
    teacherTimezone: teacher.timezone,
    storage: deps.storage ?? null,
  });
  if (!built.ok) {
    // A class canceled/rescheduled between enqueue and delivery is an expected
    // race (see the "Defense-in-depth" guard in buildVariables), not a system
    // failure — treat it like the preference/onboarding suppression gates
    // above: quiet, no Sentry alert (Sentry SPIRALCLASS-1Z was this reason
    // paging as a warning on every occurrence).
    if (built.reason.startsWith("booking-not-scheduled:")) {
      return await markSuppressed(deps.prisma, notification.id, now, built.reason);
    }
    return await markFailed(deps.prisma, notification.id, now, built.reason);
  }

  // Compute per-category channel restriction. Non-suppressible templates
  // (transactional + billing-critical) always use all channels — their
  // category is null, so allowedChannels stays null (no restriction).
  // For everything else, the recipient's channelPrefs for that category
  // narrows which channels are attempted.
  const categoryForChannels: string | null = isTeacherRecipient
    ? teacherTemplateCategory(templateName)
    : templateCategory(templateName);
  const allowedChannels =
    !isTransactionalTemplate(templateName) && categoryForChannels
      ? getAllowedChannels(isTeacherRecipient ? teacherPrefs : studentPrefs, categoryForChannels)
      : null;

  const { channels } = resolveChannels({
    recipient,
    allowedChannels,
  });

  if (channels.length === 0) {
    return await markFailed(
      deps.prisma,
      notification.id,
      now,
      "undeliverable:no_eligible_channels",
    );
  }

  // Idempotency: on a Inngest retry, skip channels already delivered in the
  // prior attempt. channelsSent is written to metadata after each successful
  // send so it survives the queued→sending→queued release cycle.
  const existingMeta: Record<string, unknown> =
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata)
      ? { ...(notification.metadata as Record<string, unknown>) }
      : {};
  const alreadySent = new Set<string>(
    Array.isArray(existingMeta.channelsSent) ? (existingMeta.channelsSent as string[]) : [],
  );
  // Local accumulator — tracks providerMessageIds for the final status write.
  const sent: Array<{ channel: "push" | "email"; providerMessageId: string }> = [];
  // Set when push landed via Web Push only. That transport reports delivery
  // synchronously and mints no receipt, so the terminal write stamps
  // delivered_at directly — otherwise poll-push-receipts would rescan the row
  // hourly for 23h looking for tickets that don't exist, and it would never
  // leave `sent`.
  let pushDeliveredSynchronously = false;
  // Running metadata snapshot updated after each channel write.
  let liveMeta: Record<string, unknown> = { ...existingMeta };

  // Push-first cascade: stop after the first successful send instead of fanning
  // out. Push failures still fall through to email (the loop's existing
  // `continue` on a non-retryable push failure), so a tokenless or
  // push-rejected recipient is emailed immediately; a reachable one is pushed
  // and — for chat only — email-checked later. Record-of-truth templates
  // (sign-in, receipts) return false here and fan out to every channel.
  const cascade = deliversPushFirst(templateName, isTeacherRecipient);

  for (const channel of channels) {
    if (alreadySent.has(channel)) {
      // A push already delivered on a prior Inngest attempt stops the cascade
      // too: don't fall through and email a message the recipient was already
      // pushed. (Only reachable if a retryable error struck between the push
      // send and the terminal markSent write.)
      if (channel === "push" && cascade) break;
      continue;
    }

    if (channel === "push") {
      const result = await attemptPushSend({
        deps,
        notificationId: notification.id,
        webSubs,
        templateName,
        languageCode,
        variables: built.variables,
      });
      // Revoke browser subscriptions the push service reported as permanently
      // gone. Done BEFORE the ok/failure split because a dead subscription
      // must be cleaned up whether or not anything else delivered — see
      // PushSendResult's failure variant.
      if (result.goneWebSubIds.length > 0) {
        await deps.prisma.webPushSubscription.updateMany({
          where: { id: { in: result.goneWebSubIds } },
          data: { revokedAt: now },
        });
      }
      if (!result.ok) {
        if (result.retryable) throw new Error(`push-retryable: ${result.error}`);
        // Non-retryable (every subscription rejected, VAPID unconfigured):
        // record the failure on the row — not only in the logs — so a silent
        // push outage is visible and queryable in the DB, then fall through to
        // email. A masked failure here is exactly what made the 2026-07-07
        // preview credential outage read as healthy "email-only" rows and
        // turned it into a multi-step hunt.
        log.warn("push send non-retryable failure, continuing to next channel", {
          notificationId: notification.id,
          error: result.error,
        });
        liveMeta = { ...liveMeta, pushError: result.error, pushErrorAt: now.toISOString() };
        await deps.prisma.notification.update({
          where: { id: notification.id },
          data: { metadata: liveMeta as Prisma.InputJsonValue },
        });
        continue;
      }
      // Web Push delivery is synchronous, so the row is delivered here rather
      // than left for a receipts poller to resolve later — there is no longer
      // any asynchronous receipt to wait for.
      pushDeliveredSynchronously = true;
      // Persist channelsSent for retry idempotency.
      alreadySent.add("push");
      liveMeta = {
        ...liveMeta,
        channelsSent: [...alreadySent],
        webPushDelivered: result.webPushDelivered,
      };
      await deps.prisma.notification.update({
        where: { id: notification.id },
        data: { metadata: liveMeta as Prisma.InputJsonValue },
      });
      sent.push({ channel: "push", providerMessageId: result.providerMessageId });
      // Cascade: push reached them — don't also email now. The delayed
      // fallback emails only if they never open the thread.
      if (cascade) break;
      continue;
    }

    if (channel === "email") {
      const result = await attemptEmailSend({
        deps,
        now,
        notification: {
          id: notification.id,
          teacherId: notification.teacherId,
          recipientType: notification.recipientType,
          metadata: notification.metadata,
        },
        recipient: { id: recipientId, email: recipientEmail! },
        templateName,
        languageCode,
        variables: built.variables,
        suppressUnsubscribeFooter,
      });
      if (!result.ok) {
        if (result.retryable) throw new Error(`email-retryable: ${result.error}`);
        // Symmetric with the push branch: persist the failure so a silent
        // email-provider outage is visible in the DB, then continue.
        log.warn("email send non-retryable failure", {
          notificationId: notification.id,
          error: result.error,
        });
        liveMeta = { ...liveMeta, emailError: result.error, emailErrorAt: now.toISOString() };
        await deps.prisma.notification.update({
          where: { id: notification.id },
          data: { metadata: liveMeta as Prisma.InputJsonValue },
        });
        continue;
      }
      alreadySent.add("email");
      liveMeta = { ...liveMeta, channelsSent: [...alreadySent] };
      await deps.prisma.notification.update({
        where: { id: notification.id },
        data: { metadata: liveMeta as Prisma.InputJsonValue },
      });
      sent.push({ channel: "email", providerMessageId: result.providerMessageId });
      continue;
    }
  }

  // Combine channels delivered in this run with any delivered in prior retries.
  const allDelivered = [...alreadySent];
  if (allDelivered.length === 0) {
    return await markFailed(
      deps.prisma,
      notification.id,
      now,
      "undeliverable:no_eligible_channels",
    );
  }

  // Primary channel = first delivered (push > email order preserved by
  // resolveChannels). The notification row records the primary; additional
  // channels are visible in metadata.channelsSent.
  const primary = sent[0] ?? {
    channel: allDelivered[0] as "push" | "email",
    providerMessageId: "prior-retry",
  };
  await deps.prisma.notification.update({
    where: { id: notification.id },
    data: {
      status: "sent",
      channel: primary.channel,
      languageCode,
      providerMessageId: primary.providerMessageId,
      sentAt: now,
      // Web-Push-only sends have no receipt to wait on: the push service
      // already accepted the message, so delivery is known now rather than up
      // to an hour later via poll-push-receipts.
      ...(pushDeliveredSynchronously && primary.channel === "push" ? { deliveredAt: now } : {}),
      metadata: { ...liveMeta, channelsSent: allDelivered } as Prisma.InputJsonValue,
      error: null,
    },
  });
  // Video-call reminder ladder, tracked so "reminder sent → joined" is
  // measurable (the call-analytics review — this was
  // previously a total blind spot). Only the class-reminder templates are
  // call-relevant; every other template (payments, materials, chat, …) is
  // out of scope here.
  const reminderLeadTimeMinutes = reminderLeadTimeMinutesFor(templateName);
  if (reminderLeadTimeMinutes !== null && notification.bookingId) {
    trackServerEvent({
      name: "call_reminder_sent",
      distinctId: recipientId,
      properties: {
        teacherId: notification.teacherId,
        studentId: notification.recipientType === "student" ? recipientId : undefined,
        bookingId: notification.bookingId,
        channel: primary.channel,
        leadTimeMinutes: reminderLeadTimeMinutes,
        recipientType: notification.recipientType,
      },
    });
    await flushAnalytics();
  }
  return {
    code: "sent",
    channel: primary.channel,
    providerMessageId: primary.providerMessageId,
    templateName,
  };
}

// Minutes-before-class each reminder template fires at, or null for a
// non-reminder template. Mirrors the *_24h/*_1h/*_5m naming the
// schedule-reminders.ts producer already uses (both the student and
// teacher-recipient variants share the same lead times).
function reminderLeadTimeMinutesFor(templateName: TemplateName): number | null {
  switch (templateName) {
    case "reminder_24h":
    case "reminder_24h_teacher":
      return 24 * 60;
    case "reminder_1h":
    case "reminder_1h_teacher":
      return 60;
    case "reminder_15m":
    case "reminder_15m_teacher":
      return 5;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-channel send helpers — return a plain result; DB writes are the
// caller's responsibility so parallel delivery can do a single status update.
// ---------------------------------------------------------------------------

type ChannelSendResult =
  { ok: true; providerMessageId: string } | { ok: false; retryable: boolean; error: string };

// Push-specific result. Web Push delivery is synchronous — the push service
// either accepted the message or it did not — so unlike the transport it
// replaced there is no ticket to record and no receipt to poll later.
type PushSendResult =
  | {
      ok: true;
      providerMessageId: string;
      // Subscription ids the push service reported as permanently gone
      // (404/410) — the caller soft-revokes them.
      goneWebSubIds: string[];
      // How many subscriptions accepted the message.
      webPushDelivered: number;
    }
  // The failure variant carries goneWebSubIds too: a subscription the push
  // service reported as permanently gone must be revoked even when NOTHING
  // was delivered. Otherwise the recipient's only (dead) subscription keeps
  // them looking push-reachable forever, so every dispatch runs a doomed push
  // attempt before falling through to email.
  | { ok: false; retryable: boolean; error: string; goneWebSubIds: string[] };

async function attemptPushSend(args: {
  deps: DispatcherDeps;
  notificationId: string;
  webSubs: WebPushSubscriptionRecord[];
  templateName: TemplateName;
  languageCode: LanguageCode;
  variables: TemplateVariables[TemplateName];
}): Promise<PushSendResult> {
  const { deps, notificationId, webSubs, templateName, languageCode, variables } = args;

  if (!deps.webPush || webSubs.length === 0) {
    return { ok: false, retryable: false, error: "no-push-transport", goneWebSubIds: [] };
  }

  const rendered = renderPush(templateName, languageCode, variables);
  const pushChannel = pushChannelForTemplate(templateName);

  const webResult = await deps.webPush.send({
    subscriptions: webSubs,
    payload: {
      title: rendered.title,
      body: rendered.body,
      // The raw suffix can carry a role prefix (`t/`, `s/`) that is not a web
      // route — rooting it at "/" 404s. Translate to the web pathname with the
      // same mapping the in-app inbox uses.
      deepLink: webPathForDeepLink(rendered.deepLink),
      // One notification row = one client-side notification: a redelivery
      // replaces the previous one rather than stacking a duplicate.
      tag: notificationId,
      urgent: pushChannel === "booking",
    },
  });

  const goneWebSubIds = webResult.goneIds;
  const webPushDelivered = webResult.deliveredIds.length;

  if (webPushDelivered > 0) {
    return {
      ok: true,
      providerMessageId: `webpush:${notificationId}`,
      goneWebSubIds,
      webPushDelivered,
    };
  }

  // Nobody was reached — a non-retryable push failure; email delivers the
  // message. Surface the distinct provider error codes ("Gone:410",
  // "Http:500", "NotConfigured") in the error string so a silent push outage
  // is diagnosable from the persisted row rather than only from logs.
  const codes = [...new Set(webResult.errorCodes)].join(",");
  return {
    ok: false,
    retryable: false,
    error: codes ? `all-push-subscriptions-rejected: ${codes}` : "all-push-subscriptions-rejected",
    goneWebSubIds,
  };
}

async function attemptEmailSend(args: {
  deps: DispatcherDeps;
  now: Date;
  notification: {
    id: string;
    teacherId: string;
    recipientType: "teacher" | "student";
    metadata: Prisma.JsonValue | null;
  };
  recipient: { id: string; email: string };
  templateName: TemplateName;
  languageCode: LanguageCode;
  variables: TemplateVariables[TemplateName];
  suppressUnsubscribeFooter: boolean;
}): Promise<ChannelSendResult> {
  const {
    deps,
    now,
    notification,
    recipient,
    templateName,
    languageCode,
    variables,
    suppressUnsubscribeFooter,
  } = args;

  const actionSuffix = urlButtonSuffix(templateName, variables);
  const actionUrl = actionSuffix === null ? null : absoluteUrl(deps.appUrl, actionSuffix);
  const unsubscribeUrl =
    !suppressUnsubscribeFooter && deps.sessionSecret
      ? absoluteUrl(
          deps.appUrl,
          `/r/email-uns/${signEmailOptOutToken(
            { studentId: recipient.id, teacherId: notification.teacherId },
            deps.sessionSecret,
            now,
          )}`,
        )
      : null;
  // Every email — teacher and student alike — carries this link, unlike the
  // opt-out footer above (student-only, suppressed for teacher sends): it
  // just opens the recipient's own notification-settings screen, so there's
  // no reason to withhold it from teacher notifications.
  const notificationSettingsUrl = deps.sessionSecret
    ? absoluteUrl(
        deps.appUrl,
        `/r/notif-settings/${signNotificationSettingsToken(
          {
            recipientId: recipient.id,
            recipientType: notification.recipientType,
            teacherId: notification.teacherId,
          },
          deps.sessionSecret,
          now,
        )}`,
      )
    : null;

  const rendered = renderEmail({
    templateName,
    languageCode,
    variables,
    actionUrl,
    unsubscribeUrl,
    notificationSettingsUrl,
    calendarUrl: emailCalendarUrl(templateName, variables, languageCode),
    appUrl: deps.appUrl,
  });
  const sendResult = await deps.email.send({
    to: recipient.email,
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
    replyTo: SUPPORT_EMAIL,
    ...(unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  });
  if (!sendResult.ok) {
    return {
      ok: false,
      retryable: sendResult.retryable,
      error: sendResult.error ?? "email-unknown",
    };
  }
  return { ok: true, providerMessageId: sendResult.providerMessageId };
}

// ---------------------------------------------------------------------------
// Chat delayed-email fallback (2026-07-07)
// ---------------------------------------------------------------------------
// Chat notifications push-first (see the cascade `break` above): when the
// recipient has the app we push and DON'T also email. The Inngest dispatch fn
// schedules this to run a few minutes later, and it sends the email ONLY if the
// recipient still hasn't opened the thread — so email stays the durable "you
// missed it" channel instead of duplicating a push they already saw.
//
// "Opened the thread" is read straight off the message rows: the chat GET route
// stamps readAt on the *sender's* messages when the recipient views them, so
// "any unread message from the sender remains" == "hasn't seen it yet". No new
// state or metadata is required, and multiple messages coalesce naturally (one
// read clears them all).

export type ChatEmailFallbackOutcome =
  | { code: "skipped"; reason: string }
  | { code: "sent"; providerMessageId: string }
  | { code: "failed"; reason: string };

export async function sendChatEmailFallbackIfUnread(
  notificationId: string,
  deps: DispatcherDeps,
): Promise<ChatEmailFallbackOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const notification = await deps.prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) return { code: "skipped", reason: "not-found" };
  if (!isChatCascadeTemplate(notification.templateName))
    return { code: "skipped", reason: "not-chat" };
  const templateName = notification.templateName as "chat_message" | "chat_message_teacher";

  const meta: Record<string, unknown> =
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata)
      ? { ...(notification.metadata as Record<string, unknown>) }
      : {};
  const channelsSent = Array.isArray(meta.channelsSent) ? (meta.channelsSent as string[]) : [];
  // A pending fallback exists only when push was the delivered channel and the
  // email hasn't already gone (idempotent across Inngest retries of this step).
  if (!channelsSent.includes("push")) return { code: "skipped", reason: "no-push-prior" };
  if (channelsSent.includes("email")) return { code: "skipped", reason: "already-emailed" };

  // Read check. The recipient opening the thread stamps readAt on the sender's
  // messages: chat_message → the teacher sent it (recipient = student);
  // chat_message_teacher → the student sent it (recipient = teacher).
  const senderRole = templateName === "chat_message" ? "teacher" : "student";
  const studentId =
    templateName === "chat_message"
      ? notification.recipientId
      : typeof meta.studentId === "string"
        ? meta.studentId
        : null;
  if (!studentId) return { code: "skipped", reason: "missing-student" };
  // Deleted-for-everyone messages must not trigger the email — the stored
  // preview would resurface content the sender explicitly retracted. Two
  // layers: (1) if THIS notification's message (metadata.messageId, stamped
  // since 2026-07-09; delete-for-everyone also removes the notification row
  // outright, so this is a race/legacy backstop) is gone or tombstoned, skip
  // regardless of other unread traffic; (2) the unread count that gates the
  // email ignores tombstones, so a fully-retracted thread stays silent.
  if (typeof meta.messageId === "string") {
    const original = await deps.prisma.message.findFirst({ where: { id: meta.messageId } });
    if (!original || original.deletedAt) return { code: "skipped", reason: "message-deleted" };
  }
  const unread = await deps.prisma.message.count({
    where: {
      teacherId: notification.teacherId,
      studentId,
      senderRole,
      readAt: null,
      deletedAt: null,
    },
  });
  if (unread === 0) return { code: "skipped", reason: "read" };

  return deliverFallbackEmail(notification, deps, now);
}

// Email-fallback delivery for the chat delayed-unread path. Resolves the
// recipient, re-applies the lifecycle gates (archived / onboarding-hold) and
// channel prefs / opt-out, then renders and sends the email and records it in
// metadata.channelsSent. It does NOT change the row's terminal status — the
// caller owns that, and the chat path leaves the row `sent`.
//
// It had a second caller once: a push-receipt escalation that emailed when a
// ticket was reported accepted but never delivered. Web Push resolves
// synchronously, so a push that does not land is already known at dispatch
// time and falls through to email there — there is no later receipt to react
// to, and nothing to escalate.
async function deliverFallbackEmail(
  notification: Notification,
  deps: DispatcherDeps,
  now: Date,
): Promise<ChatEmailFallbackOutcome> {
  const notificationId = notification.id;
  const templateName = notification.templateName as TemplateName;
  const meta: Record<string, unknown> =
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata)
      ? { ...(notification.metadata as Record<string, unknown>) }
      : {};
  const channelsSent = Array.isArray(meta.channelsSent) ? (meta.channelsSent as string[]) : [];

  // Teacher supplies the name + timezone every template's variables need, and is
  // the recipient for teacher-facing templates.
  const teacher = await deps.prisma.teacher.findUnique({
    where: { id: notification.teacherId },
    select: {
      id: true,
      name: true,
      email: true,
      timezone: true,
      locale: true,
      notificationPrefs: true,
      emailOptIn: true,
    },
  });
  if (!teacher) return { code: "skipped", reason: "teacher-not-found" };

  const isTeacherRecipient =
    notification.recipientType === "teacher" &&
    isTeacherRecipientTemplate(templateName) &&
    notification.recipientId === notification.teacherId;

  let recipientId: string;
  let recipientEmail: string | null;
  let languageCode: LanguageCode;
  let recipient: Recipient;
  let allowedChannels: ("push" | "email")[] | null;
  let suppressUnsubscribeFooter: boolean;
  // See the identical field on the main dispatch path above — dates must
  // render in the actual recipient's zone/locale, not always the teacher's.
  let recipientTimezone: string;
  let recipientLocale: string;

  if (isTeacherRecipient) {
    if (!teacher.email) return { code: "skipped", reason: "teacher-email-missing" };
    recipientId = teacher.id;
    recipientEmail = teacher.email;
    languageCode = localeToLanguageCode(teacher.locale);
    recipientTimezone = teacher.timezone;
    recipientLocale = teacher.locale;
    suppressUnsubscribeFooter = true;
    const teacherPrefs = teacher.notificationPrefs
      ? coerceTeacherNotificationPrefs(teacher.notificationPrefs)
      : null;
    allowedChannels = getAllowedChannels(
      teacherPrefs,
      teacherTemplateCategory(templateName) ?? "messages",
    );
    recipient = { email: teacher.email, emailOptIn: teacher.emailOptIn };
  } else {
    const student = await deps.prisma.student.findFirst({
      where: {
        id: notification.recipientId,
        teacherStudents: { some: { teacherId: notification.teacherId } },
      },
      select: {
        id: true,
        email: true,
        emailOptIn: true,
        notificationPrefs: true,
        locale: true,
        timezone: true,
        teacherStudents: {
          where: { teacherId: notification.teacherId },
          select: { archivedAt: true, onboardingHoldAt: true },
        },
      },
    });
    if (!student) return { code: "skipped", reason: "student-not-found" };
    // Pairing archived / on onboarding-hold since the push went out → drop the
    // email, mirroring the main dispatcher's lifecycle gates.
    if (student.teacherStudents[0]?.archivedAt != null)
      return { code: "skipped", reason: "link-archived" };
    if (student.teacherStudents[0]?.onboardingHoldAt != null) {
      return { code: "skipped", reason: "onboarding-hold" };
    }
    recipientId = student.id;
    recipientEmail = student.email;
    languageCode = localeToLanguageCode(student.locale);
    recipientTimezone = student.timezone ?? teacher.timezone;
    recipientLocale = student.locale;
    suppressUnsubscribeFooter = false;
    const studentPrefs = (student.notificationPrefs ?? null) as NotificationPrefs | null;
    allowedChannels = getAllowedChannels(
      studentPrefs,
      templateCategory(templateName) ?? "messages",
    );
    recipient = { email: student.email, emailOptIn: student.emailOptIn };
  }

  // Honor the recipient's channel prefs / email opt-out for the category — the
  // same gate the immediate pass applied.
  const { channels } = resolveChannels({ recipient, allowedChannels });
  if (!channels.includes("email") || !recipientEmail) {
    return { code: "skipped", reason: "email-ineligible" };
  }

  const built = await buildVariables(deps.prisma, {
    templateName,
    notification: {
      id: notification.id,
      teacherId: notification.teacherId,
      bookingId: notification.bookingId,
      paymentId: notification.paymentId,
      metadata: notification.metadata,
    },
    teacherName: teacher.name,
    recipientTimezone,
    recipientLocale,
    teacherTimezone: teacher.timezone,
    storage: deps.storage ?? null,
  });
  if (!built.ok) return { code: "failed", reason: built.reason };

  const result = await attemptEmailSend({
    deps,
    now,
    notification: {
      id: notification.id,
      teacherId: notification.teacherId,
      recipientType: notification.recipientType as "teacher" | "student",
      metadata: notification.metadata,
    },
    recipient: { id: recipientId, email: recipientEmail },
    templateName,
    languageCode,
    variables: built.variables,
    suppressUnsubscribeFooter,
  });
  if (!result.ok) {
    // Best-effort: a failed fallback email must not itself throw. Log and let the
    // caller decide the terminal status.
    log.warn("email fallback send failed", { notificationId, error: result.error });
    return { code: "failed", reason: result.error };
  }

  const newChannelsSent = [...new Set([...channelsSent, "email"])];
  await deps.prisma.notification.update({
    where: { id: notification.id },
    data: { metadata: { ...meta, channelsSent: newChannelsSent } as Prisma.InputJsonValue },
  });
  return { code: "sent", providerMessageId: result.providerMessageId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isKnownTemplate(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name);
}

// Preference-based suppression is expected, not an error: record it on the
// row (terminal + auditable via `error`) but stay quiet — no Sentry alert,
// no warning-level log — so a student turning a category off (or the whole
// imported roster being off) doesn't page anyone.
async function markSuppressed(
  prisma: Pick<PrismaClient, "notification">,
  id: string,
  now: Date,
  reason: string,
): Promise<DispatchOutcome> {
  await prisma.notification.update({
    where: { id },
    // `suppressed`, not `failed`: deliberate non-delivery (opt-out, archived
    // link, onboarding hold) must not pollute delivery-failure dashboards.
    data: { status: "suppressed", error: reason, failedAt: now },
  });
  return { code: "noop", reason: "preference-disabled" };
}

async function markFailed(
  prisma: Pick<PrismaClient, "notification">,
  id: string,
  now: Date,
  reason: string,
): Promise<DispatchOutcome> {
  log.warn("notification failed", { notificationId: id, reason });
  // `undeliverable:*` reasons are terminal business outcomes, not faults: the
  // recipient has no channel we're allowed to use (every category off, or no
  // address/token on file). Nothing is broken and no operator action follows,
  // so reporting them to Sentry only produced a permanently-open issue
  // (SPIRALCLASS-1Z) that a genuine dispatch failure would then hide behind.
  //
  // Still fully diagnosable without Sentry: the row is persisted below with
  // `status: "failed"` and this exact reason, and the line above logs it. If
  // a student who SHOULD be reachable stops receiving mail, that shows up as
  // a failed notification row — which is the thing worth querying anyway.
  if (!reason.startsWith("undeliverable:")) {
    Sentry.captureMessage("dispatcher notification failed", {
      level: "warning",
      extra: { notificationId: id, reason },
      tags: { surface: "dispatcher" },
    });
  }
  await prisma.notification.update({
    where: { id },
    data: { status: "failed", error: reason, failedAt: now },
  });
  return { code: "failed", reason };
}

function absoluteUrl(appUrl: string, suffix: string): string {
  if (/^https?:\/\//i.test(suffix)) return suffix;
  return `${appUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

// Builds the "Add to calendar" (Google Calendar template) link for the booking
// emails, from the email-only `calendarStartIso`/`calendarEndIso` extras the
// dispatcher stashes on those templates' variables. Returns null for every
// other template (or when the data is absent), so the secondary link simply
// doesn't render.
function emailCalendarUrl(
  templateName: TemplateName,
  variables: TemplateVariables[TemplateName],
  languageCode: LanguageCode,
): string | null {
  const v = variables as {
    calendarStartIso?: string;
    calendarEndIso?: string;
    teacherName?: string;
    studentName?: string;
  };
  if (!v.calendarStartIso || !v.calendarEndIso) return null;
  const es = languageCode === "es_MX";

  let title: string;
  if (templateName === "booking_created_teacher") {
    title = es ? `Clase: ${v.studentName}` : `Class: ${v.studentName}`;
  } else if (templateName === "reminder_24h_teacher" || templateName === "reminder_1h_teacher") {
    // Teacher-recipient reminders name the student (reminder_15m_teacher carries
    // no calendar ISO, so it never reaches this builder).
    title = es ? `Clase con ${v.studentName}` : `Class with ${v.studentName}`;
  } else if (
    templateName === "booking_confirmation" ||
    templateName === "reminder_24h" ||
    templateName === "reminder_1h" ||
    templateName === "reminder_15m"
  ) {
    title = es ? `Clase con ${v.teacherName}` : `Class with ${v.teacherName}`;
  } else {
    return null;
  }

  return buildGoogleCalendarUrl({
    start: new Date(v.calendarStartIso),
    end: new Date(v.calendarEndIso),
    title,
  });
}

// ---------------------------------------------------------------------------
// Per-template variable builders
// ---------------------------------------------------------------------------

export type BuildContext = {
  templateName: TemplateName;
  notification: {
    id: string;
    teacherId: string;
    bookingId: string | null;
    paymentId: string | null;
    metadata: Prisma.JsonValue | null;
  };
  teacherName: string;
  // The zone/locale to render every date variable in. Equal to the teacher's
  // own for a teacher-recipient template; for a student-recipient template
  // it's the STUDENT's (falling back to the teacher's zone when unset) — a
  // student must see her own local time, not her teacher's. See dispatcher.ts
  // §recipientTimezone call sites and inbox.ts (which threads the viewer's
  // own zone/locale through for the same reason).
  recipientTimezone: string;
  recipientLocale: string;
  // The TEACHER's own zone, regardless of who the recipient is — needed as
  // the "other participant" zone for student-recipient class-time templates
  // (formatClassDateTime above). Optional back-compat fallback: when a
  // caller omits it (older tests), the dual-zone suffix degrades to
  // repeating the primary time rather than crashing — every real call site
  // (dispatcher.ts, inbox.ts) passes the real value.
  teacherTimezone?: string;
  storage: StorageProvider | null;
  // Optional preloaded (teacherId, bookingId) → booking map. When supplied,
  // loadBooking reads from it instead of issuing a per-row query — set by the
  // inbox batch renderer to collapse its N+1. The live dispatch path leaves it
  // undefined (one notification per call, nothing to batch).
  bookingCache?: Map<string, LoadedBooking | null>;
  // Same batching as bookingCache, for the payment/package-keyed templates
  // below (see preloadPayments/preloadPackages).
  paymentCache?: Map<string, LoadedPayment | null>;
  packageCache?: Map<string, LoadedPackage | null>;
};

export type BuildResult =
  { ok: true; variables: TemplateVariables[TemplateName] } | { ok: false; reason: string };

// Exported so the in-app notifications inbox (src/lib/notifications/inbox.ts)
// renders each stored row through the exact same variable assembly the
// dispatcher uses for push/email — the inbox copy can never drift from what
// the recipient was actually sent.
export async function buildVariables(
  prisma: PrismaClient,
  ctx: BuildContext,
): Promise<BuildResult> {
  const t = ctx.templateName;
  // Trim stray whitespace so a name stored as "Alicia Moreno " doesn't render as a
  // double space in copy like "Tu clase con Alicia Moreno  está confirmada". Student
  // names are trimmed at their interpolation sites below for the same reason.
  const teacherName = ctx.teacherName.trim();
  const teacherTimezone = ctx.teacherTimezone ?? ctx.recipientTimezone;

  switch (t) {
    case "booking_confirmation":
    case "reminder_24h":
    case "reminder_1h":
    case "reminder_15m":
    case "materials_send": {
      if (!ctx.notification.bookingId) return { ok: false, reason: `missing-booking-id:${t}` };
      const booking = await loadBooking(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.bookingId,
        ctx.bookingCache,
      );
      if (!booking) return { ok: false, reason: "booking-not-found" };
      // Defense-in-depth against a stale "your class is coming up". The reminder
      // scheduler already re-checks status when it ENQUEUES (schedule-reminders.ts),
      // but a class canceled/rescheduled between enqueue and delivery — or during
      // the dispatcher's queued→sending→queued retry cycle — would otherwise still
      // send. Every template in this block ("class is on" confirmations, reminders,
      // materials) is meaningless once the class is off. The cancel family below is
      // intentionally NOT guarded: it must render for canceled bookings.
      if (booking.status !== "scheduled") {
        return { ok: false, reason: `booking-not-scheduled:${booking.status}` };
      }
      const classDateTime = formatClassDateTime(
        booking.scheduledStart,
        ctx.recipientTimezone,
        ctx.recipientLocale,
        teacherTimezone,
        teacherName,
      );
      const calendarStartIso = booking.scheduledStart.toISOString();
      const calendarEndIso = booking.scheduledEnd.toISOString();
      // "Join video call" button is offered on the confirmation + reminders only
      // when the call is actually usable (D-16); never on materials_send.
      const joinPathSuffix =
        t === "materials_send"
          ? undefined
          : await callJoinSuffix(prisma, ctx.notification.teacherId, booking.id);
      if (t === "booking_confirmation") {
        const pkg = await loadPackage(
          prisma,
          ctx.notification.teacherId,
          booking.packageId,
          ctx.packageCache,
        );
        const classesRemaining = pkg ? Math.max(0, pkg.classesTotal - pkg.classesUsed) : 0;
        return {
          ok: true,
          variables: {
            teacherName,
            classDateTime,
            classesRemaining: String(classesRemaining),
            calendarStartIso,
            calendarEndIso,
            joinPathSuffix,
            classPathSuffix: `s/class/${booking.id}`,
          },
        };
      }
      if (t === "materials_send") {
        const md = (ctx.notification.metadata ?? {}) as MaterialsSendMetadata;
        let materialsUrl: string | null = null;
        if (md.storagePath && ctx.storage) {
          materialsUrl = await mintMaterialsSignedUrl(ctx.storage, md.storagePath);
        }
        if (!materialsUrl) materialsUrl = md.materialsUrl ?? null;
        return {
          ok: true,
          variables: {
            teacherName,
            classDateTime,
            materialsPathSuffix: materialsUrl
              ? stripLeadingSlash(materialsUrl)
              : `r/mat/${booking.id}`,
          },
        };
      }
      return {
        ok: true,
        variables: {
          teacherName,
          classDateTime,
          calendarStartIso,
          calendarEndIso,
          joinPathSuffix,
          classPathSuffix: `s/class/${booking.id}`,
        },
      };
    }

    case "reminder_24h_teacher":
    case "reminder_1h_teacher":
    case "reminder_15m_teacher": {
      if (!ctx.notification.bookingId) return { ok: false, reason: `missing-booking-id:${t}` };
      // Self-contained query (not loadBooking) because the teacher copy names the
      // student — BOOKING_SELECT doesn't carry the student relation.
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: {
          id: true,
          status: true,
          scheduledStart: true,
          scheduledEnd: true,
          student: { select: { name: true, timezone: true } },
        },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      // Same stale-send guard as the student reminders: a class canceled or
      // rescheduled between enqueue and delivery must not fire a reminder.
      if (booking.status !== "scheduled") {
        return { ok: false, reason: `booking-not-scheduled:${booking.status}` };
      }
      const studentName = booking.student.name.trim();
      const base = {
        studentName,
        classDateTime: formatClassDateTime(
          booking.scheduledStart,
          ctx.recipientTimezone,
          ctx.recipientLocale,
          booking.student.timezone ?? teacherTimezone,
          studentName,
        ),
        // "Join video call" button — teacher's own call route, offered on the
        // same terms as the student reminders (call available for this booking).
        joinPathSuffix: await callJoinSuffixTeacher(prisma, ctx.notification.teacherId, booking.id),
        classPathSuffix: `dashboard/classes/${booking.id}`,
      };
      if (t === "reminder_15m_teacher") {
        return { ok: true, variables: base };
      }
      return {
        ok: true,
        variables: {
          ...base,
          calendarStartIso: booking.scheduledStart.toISOString(),
          calendarEndIso: booking.scheduledEnd.toISOString(),
        },
      };
    }

    case "cancel_lt24h":
    case "cancel_gte24h_with_reschedule":
    case "teacher_cancel": {
      if (!ctx.notification.bookingId) return { ok: false, reason: `missing-booking-id:${t}` };
      const booking = await loadBooking(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.bookingId,
        ctx.bookingCache,
      );
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const originalDateTime = formatClassDateTime(
        booking.scheduledStart,
        ctx.recipientTimezone,
        ctx.recipientLocale,
        teacherTimezone,
        teacherName,
      );
      const reschedulePathSuffix = `r/re/${booking.id}`;
      if (t === "cancel_lt24h") {
        return { ok: true, variables: { teacherName, originalDateTime, reschedulePathSuffix } };
      }
      return {
        ok: true,
        variables: { teacherName, originalDateTime, reschedulePathSuffix },
      };
    }

    case "reschedule_confirm": {
      if (!ctx.notification.bookingId)
        return { ok: false, reason: "missing-booking-id:reschedule_confirm" };
      const booking = await loadBooking(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.bookingId,
        ctx.bookingCache,
      );
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const md = (ctx.notification.metadata ?? {}) as RescheduleConfirmMetadata;
      if (!md.oldScheduledStart) return { ok: false, reason: "missing-metadata:oldScheduledStart" };
      return {
        ok: true,
        variables: {
          teacherName,
          oldDateTime: formatClassDateTime(
            new Date(md.oldScheduledStart),
            ctx.recipientTimezone,
            ctx.recipientLocale,
            teacherTimezone,
            teacherName,
          ),
          newDateTime: formatClassDateTime(
            booking.scheduledStart,
            ctx.recipientTimezone,
            ctx.recipientLocale,
            teacherTimezone,
            teacherName,
          ),
          classPathSuffix: `s/class/${booking.id}`,
        },
      };
    }

    case "payment_received": {
      if (!ctx.notification.paymentId)
        return { ok: false, reason: "missing-payment-id:payment_received" };
      const md = (ctx.notification.metadata ?? {}) as PaymentReceivedMetadata;
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          portalPathSuffix: `r/p/${md.packageId ?? payment.package.id}`,
        },
      };
    }

    case "magic_link": {
      const md = (ctx.notification.metadata ?? {}) as MagicLinkMetadata;
      if (!md.magicLinkUrl) return { ok: false, reason: "missing-metadata:magicLinkUrl" };
      const suffix = `r/ml/${ctx.notification.id}`;
      return {
        ok: true,
        variables: {
          teacherName,
          expiryMinutes: String(md.expiryMinutes ?? 60),
          magicLinkPathSuffix: suffix,
        },
      };
    }

    case "payment_pending_teacher":
    case "payment_marked_sent_teacher":
    case "wise_confirm_reminder_teacher": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: `missing-payment-id:${t}` };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: payment.package.student.name.trim(),
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "indefinite"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          wiseReference: payment.paymentReference ?? "(sin referencia)",
          paymentPathSuffix: `payments/${payment.id}`,
        },
      };
    }

    case "wise_marked_sent_student": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:wise_marked_sent_student" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          wiseReference: payment.paymentReference ?? "(sin referencia)",
          portalPathSuffix: "my-classes",
        },
      };
    }

    case "payment_received_teacher": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:payment_received_teacher" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: payment.package.student.name.trim(),
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "indefinite"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          paymentPathSuffix: `payments/${payment.id}`,
        },
      };
    }

    case "payment_failed_student": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:payment_failed_student" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          retryPathSuffix: `b/${payment.package.teacher.bookingSlug}`,
        },
      };
    }

    case "refund_issued_student": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:refund_issued_student" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          portalPathSuffix: "my-classes",
        },
      };
    }

    case "refund_issued_teacher": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:refund_issued_teacher" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: payment.package.student.name.trim(),
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "indefinite"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          paymentPathSuffix: `payments/${payment.id}`,
        },
      };
    }

    // Lost chargeback. Same payment join as the refund pair — including the
    // payment's own currency, since this states an amount someone was really
    // charged — but its own copy, because a chargeback is not a refund.
    case "dispute_lost_student": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:dispute_lost_student" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          portalPathSuffix: "my-classes",
        },
      };
    }

    case "dispute_lost_teacher": {
      if (!ctx.notification.paymentId) {
        return { ok: false, reason: "missing-payment-id:dispute_lost_teacher" };
      }
      const payment = await loadPayment(
        prisma,
        ctx.notification.teacherId,
        ctx.notification.paymentId,
        ctx.paymentCache,
      );
      if (!payment) return { ok: false, reason: "payment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: payment.package.student.name.trim(),
          packageName:
            payment.package.template?.name ?? packagePlaceholder(ctx.recipientLocale, "indefinite"),
          amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
          paymentPathSuffix: `payments/${payment.id}`,
        },
      };
    }

    case "stripe_ready_teacher": {
      const teacherRow = await prisma.teacher.findUnique({
        where: { id: ctx.notification.teacherId },
        select: { bookingSlug: true },
      });
      if (!teacherRow) return { ok: false, reason: "teacher-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          bookingLinkPathSuffix: `b/${teacherRow.bookingSlug}`,
        },
      };
    }

    case "stripe_requirements_teacher": {
      return {
        ok: true,
        variables: {
          teacherName,
          stripeSettingsPathSuffix: "settings/payments",
        },
      };
    }

    case "account_disabled_teacher": {
      const teacherRow = await prisma.teacher.findUnique({
        where: { id: ctx.notification.teacherId },
        select: { disabledReason: true },
      });
      if (!teacherRow) return { ok: false, reason: "teacher-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          reason: teacherRow.disabledReason ?? "Sin motivo registrado.",
        },
      };
    }

    case "booking_created_teacher": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:booking_created_teacher" };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: {
          id: true,
          scheduledStart: true,
          scheduledEnd: true,
          student: { select: { name: true, timezone: true } },
        },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const studentName = booking.student.name.trim();
      return {
        ok: true,
        variables: {
          teacherName,
          studentName,
          classDateTime: formatClassDateTime(
            booking.scheduledStart,
            ctx.recipientTimezone,
            ctx.recipientLocale,
            booking.student.timezone ?? teacherTimezone,
            studentName,
          ),
          dashboardPathSuffix: `dashboard/classes/${booking.id}`,
          calendarStartIso: booking.scheduledStart.toISOString(),
          calendarEndIso: booking.scheduledEnd.toISOString(),
        },
      };
    }

    case "homework_submitted_teacher": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:homework_submitted_teacher" };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: { id: true, student: { select: { name: true } } },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const meta = (ctx.notification.metadata ?? {}) as { assignmentTitle?: unknown };
      const assignmentTitle =
        typeof meta.assignmentTitle === "string" && meta.assignmentTitle.trim()
          ? meta.assignmentTitle.trim()
          : "";
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: booking.student.name.trim(),
          assignmentTitle,
          dashboardPathSuffix: `dashboard/classes/${booking.id}`,
        },
      };
    }

    case "homework_assigned_student": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:homework_assigned_student" };
      }
      const meta = (ctx.notification.metadata ?? {}) as { assignmentTitle?: unknown };
      const assignmentTitle =
        typeof meta.assignmentTitle === "string" && meta.assignmentTitle.trim()
          ? meta.assignmentTitle.trim()
          : "";
      return {
        ok: true,
        variables: {
          teacherName,
          assignmentTitle,
          classPathSuffix: `s/class/${ctx.notification.bookingId}`,
        },
      };
    }

    case "homework_feedback_available_student": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:homework_feedback_available_student" };
      }
      const meta = (ctx.notification.metadata ?? {}) as {
        assignmentTitle?: unknown;
        decision?: unknown;
      };
      const assignmentTitle =
        typeof meta.assignmentTitle === "string" && meta.assignmentTitle.trim()
          ? meta.assignmentTitle.trim()
          : "";
      const decision =
        meta.decision === "approved" ||
        meta.decision === "resubmission_requested" ||
        meta.decision === "rejected"
          ? meta.decision
          : "approved";
      return {
        ok: true,
        variables: {
          teacherName,
          assignmentTitle,
          decision,
          classPathSuffix: `s/class/${ctx.notification.bookingId}`,
        },
      };
    }

    case "homework_due_soon_student": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:homework_due_soon_student" };
      }
      const md = (ctx.notification.metadata ?? {}) as HomeworkDueSoonMetadata;
      if (!md.assignmentId) return { ok: false, reason: "missing-metadata:assignmentId" };
      const assignment = await prisma.assignment.findFirst({
        where: { id: md.assignmentId, teacherId: ctx.notification.teacherId },
        select: { title: true, dueAt: true },
      });
      if (!assignment || !assignment.dueAt) return { ok: false, reason: "assignment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          assignmentTitle: assignment.title,
          dueDate: formatDateTimeInZone(
            assignment.dueAt,
            ctx.recipientTimezone,
            ctx.recipientLocale,
          ),
          classPathSuffix: `s/class/${ctx.notification.bookingId}`,
        },
      };
    }

    case "homework_overdue_student": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:homework_overdue_student" };
      }
      const md = (ctx.notification.metadata ?? {}) as HomeworkOverdueMetadata;
      if (!md.assignmentId) return { ok: false, reason: "missing-metadata:assignmentId" };
      const assignment = await prisma.assignment.findFirst({
        where: { id: md.assignmentId, teacherId: ctx.notification.teacherId },
        select: { title: true },
      });
      if (!assignment) return { ok: false, reason: "assignment-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          assignmentTitle: assignment.title,
          classPathSuffix: `s/class/${ctx.notification.bookingId}`,
        },
      };
    }

    case "lesson_insights_review_teacher": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:lesson_insights_review_teacher" };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: { id: true, student: { select: { name: true } } },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const meta = (ctx.notification.metadata ?? {}) as { count?: unknown };
      const count = typeof meta.count === "number" ? meta.count : 0;
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: booking.student.name.trim(),
          count,
          dashboardPathSuffix: `dashboard/classes/${booking.id}`,
        },
      };
    }

    case "facebook_groups_nudge_teacher": {
      const meta = (ctx.notification.metadata ?? {}) as { groupCount?: unknown };
      const groupCount = typeof meta.groupCount === "number" ? meta.groupCount : 0;
      return {
        ok: true,
        variables: {
          teacherName,
          groupCount,
          dashboardPathSuffix: "dashboard/get-students",
        },
      };
    }

    case "student_acquisition_plan_teacher": {
      const meta = (ctx.notification.metadata ?? {}) as {
        actionCount?: unknown;
        firstAction?: unknown;
        minutes?: unknown;
      };
      return {
        ok: true,
        variables: {
          teacherName,
          actionCount: typeof meta.actionCount === "number" ? meta.actionCount : 0,
          firstAction: typeof meta.firstAction === "string" ? meta.firstAction : "",
          minutes: typeof meta.minutes === "number" ? meta.minutes : 0,
          dashboardPathSuffix: "dashboard/get-students",
        },
      };
    }

    case "cancel_lt24h_teacher":
    case "cancel_gte24h_teacher": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: `missing-booking-id:${t}` };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: {
          id: true,
          scheduledStart: true,
          studentId: true,
          student: { select: { name: true, timezone: true } },
        },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      // Archived pairing ("dar de baja") suppresses the student's own cancel
      // notice, silently by design — tell the teacher in her mirror so the
      // gap is visible where she'll actually see it.
      const link = await prisma.teacherStudent.findUnique({
        where: {
          teacherId_studentId: {
            teacherId: ctx.notification.teacherId,
            studentId: booking.studentId,
          },
        },
        select: { archivedAt: true },
      });
      const studentName = booking.student.name.trim();
      return {
        ok: true,
        variables: {
          teacherName,
          studentName,
          originalDateTime: formatClassDateTime(
            booking.scheduledStart,
            ctx.recipientTimezone,
            ctx.recipientLocale,
            booking.student.timezone ?? teacherTimezone,
            studentName,
          ),
          studentArchived: link?.archivedAt != null,
          dashboardPathSuffix: `dashboard/classes/${booking.id}`,
        },
      };
    }

    case "reschedule_confirm_teacher": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:reschedule_confirm_teacher" };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: {
          id: true,
          scheduledStart: true,
          student: { select: { name: true, timezone: true } },
        },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      const md = (ctx.notification.metadata ?? {}) as RescheduleConfirmMetadata;
      if (!md.oldScheduledStart) {
        return { ok: false, reason: "missing-metadata:oldScheduledStart" };
      }
      const studentName = booking.student.name.trim();
      const studentTz = booking.student.timezone ?? teacherTimezone;
      return {
        ok: true,
        variables: {
          teacherName,
          studentName,
          oldDateTime: formatClassDateTime(
            new Date(md.oldScheduledStart),
            ctx.recipientTimezone,
            ctx.recipientLocale,
            studentTz,
            studentName,
          ),
          newDateTime: formatClassDateTime(
            booking.scheduledStart,
            ctx.recipientTimezone,
            ctx.recipientLocale,
            studentTz,
            studentName,
          ),
          dashboardPathSuffix: `dashboard/classes/${booking.id}`,
        },
      };
    }

    case "no_show_student": {
      if (!ctx.notification.bookingId) {
        return { ok: false, reason: "missing-booking-id:no_show_student" };
      }
      const booking = await prisma.booking.findFirst({
        where: { id: ctx.notification.bookingId, teacherId: ctx.notification.teacherId },
        select: { id: true, scheduledStart: true },
      });
      if (!booking) return { ok: false, reason: "booking-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          originalDateTime: formatClassDateTime(
            booking.scheduledStart,
            ctx.recipientTimezone,
            ctx.recipientLocale,
            teacherTimezone,
            teacherName,
          ),
          classPathSuffix: `s/class/${booking.id}`,
        },
      };
    }

    case "package_expiry_nudge": {
      const md = (ctx.notification.metadata ?? {}) as PackageExpiryNudgeMetadata;
      if (!md.packageId) return { ok: false, reason: "missing-metadata:packageId" };
      const pkg = await loadPackage(
        prisma,
        ctx.notification.teacherId,
        md.packageId,
        ctx.packageCache,
      );
      if (!pkg || !pkg.expiresAt) return { ok: false, reason: "package-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName: pkg.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          classesRemaining: String(Math.max(0, pkg.classesTotal - pkg.classesUsed)),
          expiryDate: formatDateTimeInZone(
            pkg.expiresAt,
            ctx.recipientTimezone,
            ctx.recipientLocale,
          ),
          bookingLinkPathSuffix: `b/${pkg.teacher.bookingSlug}`,
          bookPathSuffix: "s/book",
        },
      };
    }

    case "package_consumed_student": {
      const md = (ctx.notification.metadata ?? {}) as PackageConsumedMetadata;
      if (!md.packageId) return { ok: false, reason: "missing-metadata:packageId" };
      const pkg = await loadPackage(
        prisma,
        ctx.notification.teacherId,
        md.packageId,
        ctx.packageCache,
      );
      if (!pkg) return { ok: false, reason: "package-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          packageName: pkg.template?.name ?? packagePlaceholder(ctx.recipientLocale, "yours"),
          // The signed-in repurchase flow — not the public booking page —
          // so the student lands with their identity attached.
          renewPathSuffix: "my-classes/buy",
        },
      };
    }

    case "package_consumed_teacher": {
      const md = (ctx.notification.metadata ?? {}) as PackageConsumedTeacherMetadata;
      if (!md.packageId) return { ok: false, reason: "missing-metadata:packageId" };
      const pkg = await loadPackage(
        prisma,
        ctx.notification.teacherId,
        md.packageId,
        ctx.packageCache,
      );
      if (!pkg) return { ok: false, reason: "package-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: pkg.student.name.trim(),
          packageName: pkg.template?.name ?? packagePlaceholder(ctx.recipientLocale, "indefinite"),
          studentPathSuffix: `dashboard/students/${pkg.studentId}`,
          // Default to true for any legacy row enqueued before this field
          // existed (those dispatch within seconds, so the window is tiny) —
          // matching the prior always-"we told them" copy.
          studentNotified: md.studentNotified ?? true,
        },
      };
    }

    // Subscription templates carry their display values in metadata (computed
    // at enqueue time), so the builder just re-reads metadata + teacherName.
    case "subscription_trial_ending": {
      const md = (ctx.notification.metadata ?? {}) as SubscriptionNotificationMetadata;
      return {
        ok: true,
        variables: {
          teacherName,
          daysRemaining: String(md.daysRemaining ?? 0),
          billingPathSuffix: "settings/billing",
        },
      };
    }
    case "subscription_payment_succeeded": {
      const md = (ctx.notification.metadata ?? {}) as SubscriptionNotificationMetadata;
      return {
        ok: true,
        variables: {
          teacherName,
          amount: formatMinorUnits(
            md.amountMinorUnits ?? 0,
            md.currency ?? PLATFORM_FALLBACK_CURRENCY,
          ),
          nextChargeDate: md.nextChargeAt
            ? formatDateTimeInZone(
                new Date(md.nextChargeAt),
                ctx.recipientTimezone,
                ctx.recipientLocale,
              )
            : "—",
          billingPathSuffix: "settings/billing",
        },
      };
    }
    case "subscription_payment_failed": {
      const md = (ctx.notification.metadata ?? {}) as SubscriptionNotificationMetadata;
      return {
        ok: true,
        variables: {
          teacherName,
          graceDays: String(md.graceDays ?? 7),
          billingPathSuffix: "settings/billing",
        },
      };
    }
    case "subscription_canceled": {
      return {
        ok: true,
        variables: { teacherName, billingPathSuffix: "settings/billing" },
      };
    }
    case "subscription_founding_price_locked": {
      const md = (ctx.notification.metadata ?? {}) as SubscriptionNotificationMetadata;
      return {
        ok: true,
        variables: {
          teacherName,
          amount: formatMinorUnits(
            md.amountMinorUnits ?? 0,
            md.currency ?? PLATFORM_FALLBACK_CURRENCY,
          ),
          billingPathSuffix: "settings/billing",
        },
      };
    }

    case "library_material_assigned": {
      const md = (ctx.notification.metadata ?? {}) as LibraryMaterialAssignedMetadata;
      if (!md.libraryMaterialId) {
        return { ok: false, reason: "missing-metadata:libraryMaterialId" };
      }
      const material = await prisma.libraryMaterial.findFirst({
        where: { id: md.libraryMaterialId, teacherId: ctx.notification.teacherId },
        select: { label: true, storagePath: true },
      });
      if (!material) return { ok: false, reason: "library-material-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          // Mirrors the title fallback the student/teacher material lists use.
          materialLabel: material.label ?? (material.storagePath ? "Archivo" : "Enlace"),
          // The student materials page lists assigned items with view links;
          // we deep-link there rather than minting a one-off signed URL.
          materialsPathSuffix: "my-classes/materials",
        },
      };
    }

    case "chat_message": {
      const md = (ctx.notification.metadata ?? {}) as ChatMessageMetadata;
      return {
        ok: true,
        variables: {
          teacherName,
          preview: typeof md.preview === "string" ? md.preview : "…",
          // Deep-link prefix `s/` → the student chat destination.
          chatPathSuffix: `s/messages/${ctx.notification.teacherId}`,
        },
      };
    }

    case "chat_message_teacher": {
      const md = (ctx.notification.metadata ?? {}) as ChatMessageTeacherMetadata;
      if (!md.studentId) return { ok: false, reason: "missing-metadata:studentId" };
      const student = await prisma.student.findFirst({
        where: {
          id: md.studentId,
          teacherStudents: { some: { teacherId: ctx.notification.teacherId } },
        },
        select: { name: true },
      });
      if (!student) return { ok: false, reason: "student-not-found" };
      return {
        ok: true,
        variables: {
          teacherName,
          studentName: student.name.trim(),
          preview: typeof md.preview === "string" ? md.preview : "…",
          // Deep-link prefix `t/` → the teacher chat destination.
          chatPathSuffix: `t/messages/${md.studentId}`,
        },
      };
    }
  }

  const _exhaustive: never = t;
  return { ok: false, reason: `unhandled-template:${_exhaustive}` };
}

export type LoadedBooking = {
  id: string;
  packageId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
};

// Stable select shared by every loadBooking call site, so a (teacherId,
// bookingId) → booking map can be preloaded once and reused (see the inbox
// batch path). The select must match {@link LoadedBooking} exactly.
const BOOKING_SELECT = {
  id: true,
  packageId: true,
  scheduledStart: true,
  scheduledEnd: true,
  status: true,
} as const;

/** Cache key for {@link BuildContext.bookingCache}. */
export function bookingCacheKey(teacherId: string, bookingId: string): string {
  return `${teacherId}:${bookingId}`;
}

async function loadBooking(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
  cache?: Map<string, LoadedBooking | null>,
): Promise<LoadedBooking | null> {
  const key = bookingCacheKey(teacherId, bookingId);
  if (cache?.has(key)) return cache.get(key) ?? null;
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId },
    select: BOOKING_SELECT,
  });
  cache?.set(key, booking);
  return booking;
}

/**
 * Batch-load bookings for many (teacherId, bookingId) pairs into a single map
 * keyed by {@link bookingCacheKey}, for callers that render many notifications
 * at once (the inbox). Collapses what would otherwise be one booking query per
 * row into one `IN` query. Pass the returned map as `ctx.bookingCache`.
 */
export async function preloadBookings(
  prisma: PrismaClient,
  refs: Array<{ teacherId: string; bookingId: string }>,
): Promise<Map<string, LoadedBooking | null>> {
  const cache = new Map<string, LoadedBooking | null>();
  const ids = [...new Set(refs.map((r) => r.bookingId))];
  if (ids.length === 0) return cache;
  const rows = await prisma.booking.findMany({
    where: { id: { in: ids } },
    select: { ...BOOKING_SELECT, teacherId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const ref of refs) {
    const row = byId.get(ref.bookingId);
    // Honor loadBooking's teacher scoping: a booking that doesn't belong to
    // this teacher resolves to null, exactly as the per-row findFirst would.
    const scoped =
      row && row.teacherId === ref.teacherId
        ? {
            id: row.id,
            packageId: row.packageId,
            scheduledStart: row.scheduledStart,
            scheduledEnd: row.scheduledEnd,
            status: row.status,
          }
        : null;
    cache.set(bookingCacheKey(ref.teacherId, ref.bookingId), scoped);
  }
  return cache;
}

// The student's in-class video call is surfaced in booking emails only when it's
// genuinely usable: LiveKit is configured AND the teacher is on Pro (the call is
// her Pro live feature, D-16). Returns the path suffix to the student call page,
// or undefined to leave the email on its default meeting-instructions copy.
async function callJoinSuffix(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
): Promise<string | undefined> {
  // Best-effort: whether to surface a join link is a presentation nicety, never
  // worth failing a notification send over. Any error (provider check or the
  // entitlements lookup) degrades to the default meeting-instructions copy.
  try {
    if (!getVideoProvider()) return undefined;
    const ent = await loadEntitlements(teacherId, new Date(), prisma);
    return ent.canUseLiveNotes ? `my-classes/${bookingId}/call` : undefined;
  } catch {
    return undefined;
  }
}

// Teacher-side counterpart of callJoinSuffix — points at the teacher's own
// dashboard call route rather than the student's. Same Pro/provider gating.
async function callJoinSuffixTeacher(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
): Promise<string | undefined> {
  try {
    if (!getVideoProvider()) return undefined;
    const ent = await loadEntitlements(teacherId, new Date(), prisma);
    return ent.canUseLiveNotes ? `dashboard/classes/${bookingId}/call` : undefined;
  } catch {
    return undefined;
  }
}

export type LoadedPayment = {
  id: string;
  amountMinorUnits: number;
  currency: string;
  paymentReference: string | null;
  package: {
    id: string;
    template: { name: string | null } | null;
    student: { name: string };
    teacher: { bookingSlug: string };
  };
};

// Stable select shared by every loadPayment call site (superset of every
// payment-keyed template's needs), so a (teacherId, paymentId) → payment map
// can be preloaded once and reused (see the inbox batch path). The select
// must match {@link LoadedPayment} exactly.
// The package template may have been deleted since the purchase, so its name
// can be null. That placeholder is interpolated straight into BOTH the Spanish
// and the English copy, so a hardcoded Spanish one put Spanish inside an
// English sentence — "Your refund of £20.00 for tu paquete" reached every
// English-reading student. Render it in the RECIPIENT's language, through the
// same locale-to-language bridge the templates themselves use: anything that
// is not es-MX reads English, exactly as those templates already do.
function packagePlaceholder(locale: string, form: "yours" | "indefinite"): string {
  const es = localeToLanguageCode(locale) === "es_MX";
  if (form === "yours") return es ? "tu paquete" : "your package";
  return es ? "un paquete" : "a package";
}

// Last resort for a SUBSCRIPTION notification queued before its metadata
// carried a currency. The platform's own billing currency (GBP since D-99),
// resolved through the same registry the rest of the platform uses — not
// `formatMinorUnits`'s MXN default, which is a TEACHER-pricing default and has
// never been what the platform charges in.
const PLATFORM_FALLBACK_CURRENCY = currencyForRegion(null);

const PAYMENT_SELECT = {
  id: true,
  amountMinorUnits: true,
  // The row records its own settlement currency, and every money notice must
  // render it. Without this each one fell through to `formatMinorUnits`'s MXN
  // default, so a teacher pricing in GBP, EUR, COP or CLP sent her students
  // receipts and refund notices denominated in pesos — money-of-record
  // templates stating an amount in a currency nobody had been charged.
  currency: true,
  paymentReference: true,
  package: {
    select: {
      id: true,
      template: { select: { name: true } },
      student: { select: { name: true } },
      teacher: { select: { bookingSlug: true } },
    },
  },
} as const;

/** Cache key for {@link BuildContext.paymentCache}. */
export function paymentCacheKey(teacherId: string, paymentId: string): string {
  return `${teacherId}:${paymentId}`;
}

async function loadPayment(
  prisma: PrismaClient,
  teacherId: string,
  paymentId: string,
  cache?: Map<string, LoadedPayment | null>,
): Promise<LoadedPayment | null> {
  const key = paymentCacheKey(teacherId, paymentId);
  if (cache?.has(key)) return cache.get(key) ?? null;
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, package: { teacherId } },
    select: PAYMENT_SELECT,
  });
  cache?.set(key, payment);
  return payment;
}

/**
 * Batch-load payments for many (teacherId, paymentId) pairs into a single map
 * keyed by {@link paymentCacheKey}, collapsing what would otherwise be one
 * payment query per inbox row into one `IN` query. Pass the returned map as
 * `ctx.paymentCache`.
 */
export async function preloadPayments(
  prisma: PrismaClient,
  refs: Array<{ teacherId: string; paymentId: string }>,
): Promise<Map<string, LoadedPayment | null>> {
  const cache = new Map<string, LoadedPayment | null>();
  const ids = [...new Set(refs.map((r) => r.paymentId))];
  if (ids.length === 0) return cache;
  const rows = await prisma.payment.findMany({
    where: { id: { in: ids } },
    select: {
      ...PAYMENT_SELECT,
      package: { select: { ...PAYMENT_SELECT.package.select, teacherId: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const ref of refs) {
    const row = byId.get(ref.paymentId);
    // Honor loadPayment's teacher scoping: a payment whose package doesn't
    // belong to this teacher resolves to null, exactly as the per-row
    // findFirst would.
    const scoped = row && row.package.teacherId === ref.teacherId ? row : null;
    cache.set(paymentCacheKey(ref.teacherId, ref.paymentId), scoped);
  }
  return cache;
}

export type LoadedPackage = {
  id: string;
  studentId: string;
  classesTotal: number;
  classesUsed: number;
  expiresAt: Date | null;
  template: { name: string | null } | null;
  teacher: { bookingSlug: string };
  student: { name: string };
};

// Superset select shared by every loadPackage call site (booking_confirmation's
// classesRemaining, package_expiry_nudge, package_consumed_student/teacher).
// Must match {@link LoadedPackage} exactly.
const PACKAGE_SELECT = {
  id: true,
  studentId: true,
  classesTotal: true,
  classesUsed: true,
  expiresAt: true,
  template: { select: { name: true } },
  teacher: { select: { bookingSlug: true } },
  student: { select: { name: true } },
} as const;

/** Cache key for {@link BuildContext.packageCache}. */
export function packageCacheKey(teacherId: string, packageId: string): string {
  return `${teacherId}:${packageId}`;
}

async function loadPackage(
  prisma: PrismaClient,
  teacherId: string,
  packageId: string,
  cache?: Map<string, LoadedPackage | null>,
): Promise<LoadedPackage | null> {
  const key = packageCacheKey(teacherId, packageId);
  if (cache?.has(key)) return cache.get(key) ?? null;
  const pkg = await prisma.package.findFirst({
    where: { id: packageId, teacherId },
    select: PACKAGE_SELECT,
  });
  cache?.set(key, pkg);
  return pkg;
}

/**
 * Batch-load packages for many (teacherId, packageId) pairs into a single map
 * keyed by {@link packageCacheKey}. Pass the returned map as `ctx.packageCache`.
 */
export async function preloadPackages(
  prisma: PrismaClient,
  refs: Array<{ teacherId: string; packageId: string }>,
): Promise<Map<string, LoadedPackage | null>> {
  const cache = new Map<string, LoadedPackage | null>();
  const ids = [...new Set(refs.map((r) => r.packageId))];
  if (ids.length === 0) return cache;
  const rows = await prisma.package.findMany({
    where: { id: { in: ids } },
    select: { ...PACKAGE_SELECT, teacherId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const ref of refs) {
    const row = byId.get(ref.packageId);
    // Honor loadPackage's teacher scoping: a package that doesn't belong to
    // this teacher resolves to null, exactly as the per-row findFirst would.
    const scoped = row && row.teacherId === ref.teacherId ? row : null;
    cache.set(packageCacheKey(ref.teacherId, ref.packageId), scoped);
  }
  return cache;
}

// The (teacherId, bookingId) needed to preload booking_confirmation's package
// via {@link preloadPackages}, resolved from an ALREADY-preloaded booking
// cache (LoadedBooking carries packageId) rather than a fresh query.
export function packageRefFromBookingCache(
  teacherId: string,
  bookingId: string,
  bookingCache: Map<string, LoadedBooking | null>,
): { teacherId: string; packageId: string } | null {
  const booking = bookingCache.get(bookingCacheKey(teacherId, bookingId));
  return booking ? { teacherId, packageId: booking.packageId } : null;
}

// Exported so the inbox batch preload (inbox-queries.ts) can determine which
// rows reference a package via metadata, without re-deriving each template's
// metadata shape itself.
export function packageIdFromNotificationMetadata(
  templateName: string,
  metadata: Prisma.JsonValue | null,
): string | null {
  switch (templateName) {
    case "package_expiry_nudge":
      return (metadata as PackageExpiryNudgeMetadata | null)?.packageId ?? null;
    case "package_consumed_student":
      return (metadata as PackageConsumedMetadata | null)?.packageId ?? null;
    case "package_consumed_teacher":
      return (metadata as PackageConsumedTeacherMetadata | null)?.packageId ?? null;
    default:
      return null;
  }
}

function stripLeadingSlash(s: string): string {
  return s.replace(/^\//, "");
}
