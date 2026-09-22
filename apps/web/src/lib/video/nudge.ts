import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  getWebPushClient,
  isWebPushConfigured,
  type WebPushClient,
} from "@/lib/notifications/web-push";
import { webPathForDeepLink } from "@/lib/notifications/web-deep-links";
import { rateLimit, type RateLimitOptions, type RateLimitResult } from "@/lib/rate-limit";
import { classCallRoom } from "@/lib/video/provider";
import { listRoomParticipantIdentities } from "@/lib/video/room";
import { logger } from "@/lib/logger";

// In-class "nudge" (D-75). When one party is in the LiveKit room and the other
// hasn't joined, the present party can ping the missing one: a DIRECT
// high-priority push (not the templated Notification → dispatcher pipeline) —
// a nudge is real-time and ephemeral, so an email/inbox copy would land after
// the moment passed. The tap routes straight to the class screen.
//
// ⚠️ **This delivered nothing at all for a month.** It fanned out across
// `device_tokens`, whose rows belonged to a transport that had been removed —
// so no row could exist and the button reported
// `ok: true, delivered: 0` on every press. The waiting-room UI reads only
// `ok`, so it said "Sent" every time, to nobody — an affordance whose
// transport had been removed underneath it.
//
// It rides **Web Push** now (the browser transport of the `push` channel,
// lib/notifications/web-push.ts), which is the one transport this product
// actually has. The parenthetical that used to sit here — "with no web push,
// unreachable on web anyway" — predates that transport existing.
//
// This is deliberately the ONLY notification lever for a scheduled call. We do
// not auto-ring both parties at start time: for a pre-agreed slot with the
// reminder ladder already sent (schedule-reminders.ts), an auto-ring is
// jarring. See D-75.

const log = logger({ surface: "class-nudge" });

// One nudge per (booking, recipient) per this window. The button also has a
// client-side cooldown; this is the server backstop against a misbehaving or
// replayed client. Short enough that a genuinely-still-waiting user can nudge
// again after a beat.
const NUDGE_COOLDOWN_MS = 45_000;

export type NudgeResult =
  | { ok: true; delivered: number }
  | {
      ok: false;
      // already-present: the counterparty (or someone else) is already in the
      //   room — nothing to nudge.
      // cooldown: nudged too recently; retryAfterSec says when to try again.
      // not-found: the booking isn't the caller's (resolved by the caller before
      //   reaching the core; included so every caller shares one return type).
      reason: "already-present" | "cooldown" | "not-found";
      retryAfterSec?: number;
    };

type Tx = Prisma.TransactionClient | PrismaClient;

// Injectable seams so the core is unit-testable without the real push transport,
// LiveKit, or the process-global rate limiter — mirrors how the dispatcher tests
// inject a stub push client.
export type NudgeDeps = {
  // Null means "this transport is not configured" (no VAPID keypair), which is
  // a delivered-0 nudge rather than an error — same treatment the dispatcher
  // gives it.
  webPush?: WebPushClient | null;
  listParticipants?: (room: string) => Promise<string[]>;
  rateLimiter?: (id: string, opts: RateLimitOptions) => Promise<RateLimitResult>;
};

export async function nudgeCounterparty(
  db: Tx,
  input: {
    bookingId: string;
    // The caller's LiveKit identity (their user id) — used to tell "someone
    // else is already here" apart from "only I'm here".
    callerIdentity: string;
    // The caller's display name, for the push copy.
    callerName: string;
    // Who to nudge. `id` is the booking's teacherId / studentId; push
    // subscriptions and locale are looked up against it.
    to: { type: "teacher" | "student"; id: string };
  },
  deps: NudgeDeps = {},
): Promise<NudgeResult> {
  const webPush =
    deps.webPush !== undefined ? deps.webPush : isWebPushConfigured() ? getWebPushClient() : null;
  const listParticipants = deps.listParticipants ?? listRoomParticipantIdentities;
  const limiter = deps.rateLimiter ?? rateLimit;

  // 1) Cooldown first — cheap, and it caps how often we hit LiveKit below.
  const limit = await limiter(`${input.bookingId}:${input.to.type}:${input.to.id}`, {
    scope: "class-nudge",
    limit: 1,
    windowMs: NUDGE_COOLDOWN_MS,
  });
  if (!limit.ok) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfterSec: Math.max(1, Math.ceil(limit.retryAfterMs / 1000)),
    };
  }

  // 2) Race guard: if anyone other than the caller is in the room, the
  //    counterparty is already here (1:1 call) — don't nudge. Checking "anyone
  //    but me" rather than matching the counterparty's exact identity is robust
  //    to a student joining under a sibling identity row (studentIdentityIds).
  const identities = await listParticipants(classCallRoom(input.bookingId));
  if (identities.some((id) => id !== input.callerIdentity)) {
    return { ok: false, reason: "already-present" };
  }

  // 3) Resolve the recipient's UI locale for the copy (Teacher.locale /
  //    Student.locale, both default "en").
  const es = await recipientPrefersSpanish(db, input.to);

  // 4) Fan out across the recipient's live browser push subscriptions. No
  //    teacher-id filter is needed because (recipientType, recipientId)
  //    already fully scopes a subscription.
  if (!webPush) return { ok: true, delivered: 0 };
  const subscriptions = await db.webPushSubscription.findMany({
    where: { recipientType: input.to.type, recipientId: input.to.id, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return { ok: true, delivered: 0 };

  // The student suffix carries a role prefix (`s/`) that is not a web route, so
  // it goes through the same mapping the dispatcher and the inbox use.
  const deepLink = webPathForDeepLink(
    input.to.type === "teacher"
      ? `dashboard/classes/${input.bookingId}`
      : `s/class/${input.bookingId}`,
  );

  const title = es ? "Tu clase te espera" : "Your class is waiting";
  const body = es
    ? `${input.callerName} ya está en la videollamada. Toca para unirte.`
    : `${input.callerName} is already in the video call. Tap to join.`;

  try {
    const result = await webPush.send({
      subscriptions,
      payload: {
        title,
        body,
        deepLink,
        // One nudge per booking per recipient: a re-press replaces the previous
        // notification rather than stacking a second one.
        tag: `class-nudge:${input.bookingId}`,
        // A nudge is a time-sensitive calendar moment — the same class of
        // urgency the dispatcher reserves for booking notifications.
        urgent: true,
      },
    });
    // Soft-revoke subscriptions the push service reported as permanently gone,
    // exactly as the dispatcher does, so a dead browser registration stops
    // counting the recipient as reachable.
    if (result.goneIds.length > 0) {
      await db.webPushSubscription.updateMany({
        where: { id: { in: result.goneIds } },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true, delivered: result.deliveredIds.length };
  } catch (err) {
    // Never surface a push-transport failure as a hard error: the sender's UI
    // only needs to know the nudge was accepted. Log and report delivered=0.
    log.warn("nudge push failed", { bookingId: input.bookingId, error: String(err) });
    return { ok: true, delivered: 0 };
  }
}

async function recipientPrefersSpanish(
  db: Tx,
  to: { type: "teacher" | "student"; id: string },
): Promise<boolean> {
  const locale =
    to.type === "teacher"
      ? (await db.teacher.findUnique({ where: { id: to.id }, select: { locale: true } }))?.locale
      : (await db.student.findUnique({ where: { id: to.id }, select: { locale: true } }))?.locale;
  return (locale ?? "en") !== "en";
}
