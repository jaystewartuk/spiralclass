import { z } from "zod";

import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { vapidConfig } from "@/lib/notifications/web-push";

// Browser Web Push subscription registration, feeding the `push` notification
// channel. Session-cookie authed — it is called from the teacher dashboard and
// the student portal. A second registration route fed the same channel over
// another transport once; this is the only push transport left.
//
// GET    → whether web push is configured, plus the VAPID public key the
//          browser needs to subscribe. Served rather than baked into a
//          NEXT_PUBLIC_ build var deliberately: a build-time value that is
//          missing from the deploy bucket vanishes silently with green CI,
//          which is exactly the OTA failure mode documented in
//          docs/features/notifications.md. Fetched at runtime, a missing key is
//          observable in one request.
// POST   → upsert the subscription keyed by its endpoint.
// DELETE → soft-revoke it (revoked_at = now), scoped to the caller.

const subscriptionSchema = z.object({
  // Push-service endpoint URLs are long (FCM's run past 200 chars) — the cap
  // is a sanity bound, not a protocol limit.
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

const deleteSchema = z.object({ endpoint: z.string().url().max(2000) });

// Resolves the caller to a notification recipient. Teacher-first, mirroring
// resolveRecipient in the mobile devices route: Teacher and Student are
// mutually exclusive per auth identity, so at most one matches.
async function resolveRecipient(
  userId: string,
): Promise<{ recipientType: "teacher" | "student"; recipientId: string } | null> {
  const teacher = await prisma.teacher.findUnique({ where: { id: userId }, select: { id: true } });
  if (teacher) return { recipientType: "teacher", recipientId: teacher.id };
  const student = await prisma.student.findFirst({
    where: { authUserId: userId },
    select: { id: true },
  });
  if (student) return { recipientType: "student", recipientId: student.id };
  return null;
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const vapid = vapidConfig();
  if (!vapid) return Response.json({ enabled: false as const, publicKey: null });
  return Response.json({ enabled: true as const, publicKey: vapid.publicKey });
}

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  // Refuse to store a subscription we could never send to. Without this a
  // recipient would appear push-reachable to the dispatcher (which counts
  // subscriptions when deciding channel eligibility) while every send failed —
  // suppressing the email that would otherwise have reached them.
  if (!vapidConfig()) {
    return Response.json({ error: "web-push-not-configured" }, { status: 503 });
  }

  const recipient = await resolveRecipient(user.id);
  if (!recipient) return Response.json({ error: "no-recipient-row" }, { status: 403 });

  let body: z.infer<typeof subscriptionSchema>;
  try {
    body = subscriptionSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }

  // Reject a takeover of a LIVE subscription owned by someone else. Endpoints
  // are unguessable, but the invariant is the same for any device token:
  // learning another user's endpoint must not let
  // you redirect their notifications to you. A revoked row may be reclaimed
  // (shared browser, previous user signed out).
  const existing = await prisma.webPushSubscription.findUnique({
    where: { endpoint: body.endpoint },
    select: { recipientType: true, recipientId: true, revokedAt: true },
  });
  if (
    existing &&
    existing.revokedAt === null &&
    (existing.recipientType !== recipient.recipientType ||
      existing.recipientId !== recipient.recipientId)
  ) {
    return Response.json({ error: "subscription-owned-by-another-recipient" }, { status: 403 });
  }

  const now = new Date();
  const userAgent = req.headers.get("user-agent")?.slice(0, 255) ?? null;

  const row = await prisma.webPushSubscription.upsert({
    where: { endpoint: body.endpoint },
    create: {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      recipientType: recipient.recipientType,
      recipientId: recipient.recipientId,
      userAgent,
    },
    update: {
      // Keys rotate when the browser rotates the subscription, so always
      // refresh them — a stale p256dh makes every send fail encryption.
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      recipientType: recipient.recipientType,
      recipientId: recipient.recipientId,
      userAgent,
      lastSeenAt: now,
      revokedAt: null,
    },
    select: { id: true },
  });

  // Bound the fan-out per recipient: browsers mint a fresh endpoint on every
  // permission reset, and dead ones are only discovered on a send. Keep the 5
  // most-recently-seen.
  const overflow = await prisma.webPushSubscription.findMany({
    where: {
      recipientType: recipient.recipientType,
      recipientId: recipient.recipientId,
      revokedAt: null,
    },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true },
    skip: 5,
  });
  if (overflow.length > 0) {
    await prisma.webPushSubscription.updateMany({
      where: { id: { in: overflow.map((s) => s.id) } },
      data: { revokedAt: now },
    });
  }

  return Response.json({ ok: true as const, id: row.id });
}

export async function DELETE(req: Request) {
  const user = await getAuthUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const recipient = await resolveRecipient(user.id);
  if (!recipient) return Response.json({ error: "no-recipient-row" }, { status: 403 });

  let body: z.infer<typeof deleteSchema>;
  try {
    body = deleteSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }

  // Scoped to the caller's own recipient — otherwise anyone who learned another
  // user's endpoint could silently suppress their notifications.
  await prisma.webPushSubscription.updateMany({
    where: {
      endpoint: body.endpoint,
      recipientType: recipient.recipientType,
      recipientId: recipient.recipientId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  return Response.json({ ok: true as const });
}
