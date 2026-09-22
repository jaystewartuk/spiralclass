import type { Prisma, PrismaClient, WebhookProvider } from "@prisma/client";

// Webhook idempotency layer. See docs/security.md and D-79.
//
// Claim-then-complete ordering. The route claims the event up front
// (`recordWebhookEvent`) so a concurrent or replayed delivery can't run
// non-idempotent side effects twice; on SUCCESS it marks the claim
// `processedAt` (`markWebhookEventProcessed`); on a thrown error it deletes the
// claim (`releaseWebhookEvent`) so the provider's retry re-claims immediately.
//
// The claim row therefore has three meanings, and `recordWebhookEvent` returns
// which one applies:
//   * "claimed"   — this caller owns the event; run the handler.
//   * "processed" — a prior delivery already completed it; ack 200, do nothing.
//   * "in_flight" — another delivery holds a FRESH (not-yet-stale) unprocessed
//                   claim; the caller must respond non-2xx so the provider
//                   retries later rather than dropping the event.
//
// Why the third state matters: the old layer only deleted the claim on a thrown
// error, so a crash/timeout AFTER the claim committed but BEFORE the handler
// finished left a permanent "seen" row, and the next retry was ack'd 200 as a
// duplicate — the event was silently lost. That was survivable for the paid
// transition (a sibling event re-drove it) but not for single-event
// transitions like charge.refunded / charge.dispute.closed. Now an unprocessed
// claim is only ever ack'd if it's genuinely in flight; once it goes stale
// (older than STALE_CLAIM_MS — longer than any real handler run, so a live
// attempt is never stolen) the next retry atomically RE-CLAIMS it and
// reprocesses. Handlers are idempotent (status-guarded updateMany), so a
// belt-and-braces re-run is safe.

export type RecordWebhookEventInput = {
  provider: WebhookProvider;
  eventId: string;
  eventType?: string | null;
};

export type WebhookClaimStatus = "claimed" | "processed" | "in_flight";
export type RecordWebhookEventResult = { status: WebhookClaimStatus };

export type RecordWebhookEventOptions = {
  // Injected for tests; defaults to the real clock.
  now?: Date;
  // How long an unprocessed claim is treated as in-flight before a retry may
  // steal it. Must exceed the longest plausible handler runtime so a live
  // attempt is never reclaimed out from under itself.
  staleClaimMs?: number;
};

type Db = Pick<PrismaClient, "webhookEvent">;

// Longer than any handler's runtime (a couple of Stripe calls + a DB tx, well
// under the serverless timeout), short enough that recovery from a dead claim
// happens within the provider's multi-day retry schedule.
const DEFAULT_STALE_CLAIM_MS = 10 * 60 * 1000;

// Release a claim taken by `recordWebhookEvent` when the handler THREW, so the
// provider's retry can re-claim and reprocess immediately. Idempotent
// (deleteMany no-ops if the row is already gone).
export async function releaseWebhookEvent(
  db: Db,
  input: Pick<RecordWebhookEventInput, "provider" | "eventId">,
): Promise<void> {
  await db.webhookEvent.deleteMany({
    where: { provider: input.provider, eventId: input.eventId },
  });
}

// Mark a claim as fully processed. Called only after the handler succeeded.
// updateMany (not update) so it no-ops rather than throwing if the row was
// released/reclaimed in the meantime.
export async function markWebhookEventProcessed(
  db: Db,
  input: Pick<RecordWebhookEventInput, "provider" | "eventId">,
  now: Date = new Date(),
): Promise<void> {
  await db.webhookEvent.updateMany({
    where: { provider: input.provider, eventId: input.eventId },
    data: { processedAt: now },
  });
}

// Read-only check: has this (provider, eventId) already been *claimed* (in any
// state)? Retained for callers that only need a cheap peek; the authoritative
// gate is recordWebhookEvent's returned status.
export async function webhookEventSeen(
  db: Db,
  input: Pick<RecordWebhookEventInput, "provider" | "eventId">,
): Promise<boolean> {
  const existing = await db.webhookEvent.findUnique({
    where: {
      provider_eventId: { provider: input.provider, eventId: input.eventId },
    },
    select: { id: true },
  });
  return existing !== null;
}

// Claim the event, or report why we can't. See the module header for the three
// outcomes.
export async function recordWebhookEvent(
  db: Db,
  input: RecordWebhookEventInput,
  opts: RecordWebhookEventOptions = {},
): Promise<RecordWebhookEventResult> {
  const now = opts.now ?? new Date();
  const staleMs = opts.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;

  // Fast path: fresh event → win the insert → we own it.
  try {
    await db.webhookEvent.create({
      data: {
        provider: input.provider,
        eventId: input.eventId,
        eventType: input.eventType ?? null,
      },
    });
    return { status: "claimed" };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }

  // A row already exists. Fully processed → true duplicate.
  const existing = await db.webhookEvent.findUnique({
    where: {
      provider_eventId: { provider: input.provider, eventId: input.eventId },
    },
    select: { processedAt: true },
  });
  if (existing?.processedAt) return { status: "processed" };

  // Unprocessed claim. Steal it only if it's gone stale (the attempt that took
  // it must have died). The re-stamp of receivedAt is the atomic guard: exactly
  // one concurrent retry can flip it, so exactly one reclaims.
  const staleCutoff = new Date(now.getTime() - staleMs);
  const reclaimed = await db.webhookEvent.updateMany({
    where: {
      provider: input.provider,
      eventId: input.eventId,
      processedAt: null,
      receivedAt: { lt: staleCutoff },
    },
    data: { receivedAt: now },
  });
  if (reclaimed.count === 1) return { status: "claimed" };

  // A fresh unprocessed claim owns it — a live concurrent attempt, or one that
  // died within the staleness window (a later retry will reclaim it). Tell the
  // caller to retry later rather than ack it as done.
  return { status: "in_flight" };
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Partial<Prisma.PrismaClientKnownRequestError>;
  return e.code === "P2002";
}
