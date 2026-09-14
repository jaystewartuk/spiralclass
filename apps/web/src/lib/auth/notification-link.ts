import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// Single-use sign-in links carried by a notification (D-40's "narrow signed
// capability tokens" for `/r/*`).
//
// A notification that asks a student to act — rebook a canceled class, open
// the portal after a first payment — links to a route that signs her in on
// the way. The URL itself is therefore a sign-in credential, and it is built
// the way a credential should be:
//
//   * **Random, not an id.** 32 bytes from the CSPRNG, base64url — nothing a
//     reader of any other page, feed or payload could already know.
//   * **Stored hashed.** Only SHA-256 of the token reaches the database, in
//     better-auth's own `verification` table, so a database read does not
//     yield a working link.
//   * **One kind per route.** The kind is part of the row's identifier, so a
//     rebook token presented to the magic-link route finds nothing, and no
//     HMAC-signed token (opt-out, settings link, OAuth state) has this shape.
//   * **Bound at issue time** to the student row and the email it had, plus
//     the one booking or notification it was issued for. Redemption re-checks
//     all three against the live rows.
//   * **Short-lived and single-use.** Consumption deletes the row, and only
//     the request whose delete removed it may proceed.
//
// No schema change: `verification` already exists for exactly this job
// (better-auth keeps its own email codes there), and an unconsumed row simply
// expires.

export type NotificationLinkKind = "rebook" | "magic-link";

// Rebook: a student told her class was canceled usually acts the same day, but
// the notice can land on a Friday evening. Three days covers a weekend without
// leaving a sign-in credential sitting in an inbox for as long as the notice
// stays there. After it lapses she lands on the expired-link page, which sends
// her to her classes through the ordinary sign-in.
//
// Magic link: the copy has always promised the link expires in an hour, and
// now it does.
export const NOTIFICATION_LINK_TTL_SECONDS: Record<NotificationLinkKind, number> = {
  rebook: 72 * 60 * 60,
  "magic-link": 60 * 60,
};

const IDENTIFIER_PREFIX = "notification-link";
const TOKEN_BYTES = 32;
// 32 bytes → 43 base64url characters, no padding.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type NotificationLinkPayload = {
  studentId: string;
  email: string;
  // The booking (rebook) or notification (magic link) the link was issued for.
  subjectId: string;
};

type VerificationClient = Pick<PrismaClient, "verification">;

function identifierFor(kind: NotificationLinkKind, token: string): string {
  const digest = createHash("sha256").update(token).digest("base64url");
  return `${IDENTIFIER_PREFIX}:${kind}:${digest}`;
}

export async function issueNotificationLinkToken(
  db: VerificationClient,
  input: NotificationLinkPayload & { kind: NotificationLinkKind; ttlSeconds?: number },
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const ttlSeconds = Math.min(
    input.ttlSeconds ?? NOTIFICATION_LINK_TTL_SECONDS[input.kind],
    NOTIFICATION_LINK_TTL_SECONDS[input.kind],
  );
  await db.verification.create({
    data: {
      identifier: identifierFor(input.kind, token),
      value: JSON.stringify({
        s: input.studentId,
        m: input.email.trim().toLowerCase(),
        x: input.subjectId,
      }),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
  });
  return token;
}

export type ConsumeNotificationLinkResult =
  | { ok: true; payload: NotificationLinkPayload }
  | { ok: false; reason: "malformed" | "not-found" | "expired" | "already-used" | "bad-payload" };

// Consumes the token: the row is deleted whatever happens next, so a link that
// fails a later check cannot be retried. Two concurrent redemptions of one
// token both find the row, but only one delete removes it — the other sees a
// count of zero and is refused.
export async function consumeNotificationLinkToken(
  db: VerificationClient,
  kind: NotificationLinkKind,
  token: string,
  now: Date = new Date(),
): Promise<ConsumeNotificationLinkResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "malformed" };

  const identifier = identifierFor(kind, token);
  const row = await db.verification.findFirst({
    where: { identifier },
    select: { id: true, value: true, expiresAt: true },
  });
  if (!row) return { ok: false, reason: "not-found" };

  const removed = await db.verification.deleteMany({ where: { id: row.id } });
  if (removed.count !== 1) return { ok: false, reason: "already-used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  let body: { s?: unknown; m?: unknown; x?: unknown };
  try {
    body = JSON.parse(row.value);
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (typeof body.s !== "string" || typeof body.m !== "string" || typeof body.x !== "string") {
    return { ok: false, reason: "bad-payload" };
  }
  return { ok: true, payload: { studentId: body.s, email: body.m, subjectId: body.x } };
}
