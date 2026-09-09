import { createHmac, timingSafeEqual } from "node:crypto";
import type { NotificationStatus, Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";

const log = logger({ surface: "resend-webhook" });

// Real delivery outcomes for email, which `status: "sent"` never carried.
//
// `sent` only ever meant "Resend's API accepted the request and returned an
// id". It says nothing about whether the message reached anyone, and the two
// are not the same thing: a message to an address on Resend's SUPPRESSION list
// is accepted, given an id, and never attempted. That is exactly what happened
// on 2026-08-31 — the operator's own address had been suppressed by earlier
// hard bounces (his domain had no Cloudflare routing rule for it), so two
// purchase emails were recorded `sent` with provider ids while Resend never
// tried to deliver either one.
//
// Nothing in the data could distinguish that from success, which is the part
// worth fixing: it is not a one-off. Any student whose address hard-bounces
// once is suppressed from then on, and every subsequent notification to them
// would read `sent` for ever while they receive nothing.
//
// The NotificationStatus enum already had `delivered` and `failed`; nothing
// wrote them for email (only push set `deliveredAt`). This is what writes them.

// Svix's scheme, which Resend uses. Signed content is `id.timestamp.body`; the
// secret is `whsec_<base64>` and the base64 half is the key.
const TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyResendSignature(input: {
  headers: SvixHeaders;
  rawBody: string;
  secret: string;
  nowSeconds?: number;
}): VerifyResult {
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing-header" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed-timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Replay window, same reasoning as the Stripe verifier's tolerance.
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const secret = input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret;
  let key: Buffer;
  try {
    key = Buffer.from(secret, "base64");
  } catch {
    return { ok: false, reason: "malformed-secret" };
  }

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${input.rawBody}`)
    .digest("base64");

  // The header carries space-separated `v1,<sig>` entries — more than one
  // during a secret rotation, so any match is a pass.
  const provided = signature
    .split(" ")
    .map((part) => part.split(",", 2))
    .filter(([version]) => version === "v1")
    .map(([, sig]) => sig ?? "");

  if (provided.length === 0) return { ok: false, reason: "no-v1-signature" };

  const expectedBuf = Buffer.from(expected);
  const match = provided.some((sig) => {
    const buf = Buffer.from(sig);
    // timingSafeEqual throws on a length mismatch, which is itself a no-match.
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });

  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}

export type EmailWebhookOutcome =
  | { code: "ignored-unhandled-type"; type: string }
  | { code: "ignored-malformed"; reason: string }
  | { code: "no-notification-row"; providerMessageId: string }
  | { code: "applied"; providerMessageId: string; status: "delivered" | "failed" }
  | { code: "noop"; reason: string };

// The two operations this handler needs, stated structurally rather than as
// `Pick<PrismaClient["notification"], …>`. Prisma's generated signatures are
// heavily overloaded, so depending on them would force every test double to
// reimplement the whole surface to satisfy the compiler. The real client
// satisfies this; so does a fake.
export type EmailWebhookPrisma = {
  updateMany(args: {
    where: { providerMessageId: string; status: { in: NotificationStatus[] } };
    data: Prisma.NotificationUpdateManyMutationInput;
  }): Promise<{ count: number }>;
  findFirst(args: {
    where: { providerMessageId: string };
    select: { status: true };
  }): Promise<{ status: NotificationStatus } | null>;
};

// Which Resend events change a row, and to what.
//
// `email.complained` (a spam report) is deliberately NOT a failure: the message
// WAS delivered, and folding it into `failed` would make delivery dashboards
// lie in the opposite direction. `email.sent`/`opened`/`clicked` add nothing
// the row does not already have.
const TERMINAL: Record<string, "delivered" | "failed"> = {
  "email.delivered": "delivered",
  "email.bounced": "failed",
  "email.failed": "failed",
};

export async function handleResendWebhook(
  payload: unknown,
  deps: { prisma: { notification: EmailWebhookPrisma }; now?: () => Date },
): Promise<EmailWebhookOutcome> {
  if (typeof payload !== "object" || payload === null) {
    return { code: "ignored-malformed", reason: "payload-not-object" };
  }
  const envelope = payload as { type?: unknown; data?: { email_id?: unknown } };
  const type = typeof envelope.type === "string" ? envelope.type : null;
  if (!type) return { code: "ignored-malformed", reason: "missing-type" };

  const status = TERMINAL[type];
  if (!status) return { code: "ignored-unhandled-type", type };

  const providerMessageId =
    typeof envelope.data?.email_id === "string" ? envelope.data.email_id : null;
  if (!providerMessageId) return { code: "ignored-malformed", reason: "missing-email-id" };

  const now = (deps.now ?? (() => new Date()))();

  // Guarded on the states a provider event may legitimately advance FROM.
  // A row already `delivered` must not be dragged back by a late duplicate,
  // and a deliberate `suppressed` (our own opt-out handling) is not ours to
  // overwrite with a provider outcome.
  const res = await deps.prisma.notification.updateMany({
    where: { providerMessageId, status: { in: ["sent", "sending", "queued"] } },
    data:
      status === "delivered"
        ? { status: "delivered", deliveredAt: now }
        : { status: "failed", failedAt: now, error: `resend:${type}` },
  });

  if (res.count === 0) {
    const existing = await deps.prisma.notification.findFirst({
      where: { providerMessageId },
      select: { status: true },
    });
    if (!existing) return { code: "no-notification-row", providerMessageId };
    return { code: "noop", reason: `already-${existing.status}` };
  }

  log.info("email outcome recorded", { providerMessageId, type, status });
  return { code: "applied", providerMessageId, status };
}
