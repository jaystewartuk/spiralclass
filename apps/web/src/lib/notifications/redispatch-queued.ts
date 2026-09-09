import type { PrismaClient } from "@prisma/client";

// Warm-up backstop (docs/architecture/overview.md):
// re-drive notifications stuck in `status='queued'`.
//
// A producer writes the notifications row inside its transaction, then emits
// `notification.queued` *best-effort after commit* (lib/notifications/events.ts
// — the emit is wrapped in try/catch so a transient dispatch-bus failure never
// fails the user action). The row is the durable source of truth; the event is
// only a fast-path trigger. If that emit is lost, the row sits `queued` forever
// with no backstop — `poll-push-receipts` only advances `sent`→`delivered`, and
// `reconcile-paid` only covers payments. The `events.ts` comment already
// promises "the cron dispatcher / a re-emit covers it"; this is that re-emit.
//
// Idempotent by construction: dispatch-notification claims a row with an atomic
// `queued`→`sending` update, so re-emitting a row that another worker is about
// to dispatch just loses the claim race — never a double-send.
//
// Bounded window, two guards:
//   * GRACE — only rows queued longer than this, so we never race an in-flight
//     dispatch or its Inngest retry backoff (which releases the claim back to
//     `queued` between attempts). The failure mode we target is a *lost* event,
//     not a slow one.
//   * MAX_AGE — stop re-driving a row that keeps failing dispatch (a genuinely
//     broken notification), so a permanently-stuck row isn't re-attempted every
//     tick forever; anomaly-alerts' failed-notification signal covers that tail.

const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_LIMIT = 200;

type NotificationEmitter = (input: { notificationId: string; teacherId: string }) => Promise<void>;

export async function redispatchStaleQueuedNotifications(deps: {
  prisma: Pick<PrismaClient, "notification">;
  // The same best-effort `notification.queued` emitter every producer uses
  // (lib/notifications/events.ts's emitNotificationQueued). Injected for tests.
  emit: NotificationEmitter;
  now?: Date;
  graceMinutes?: number;
  maxAgeHours?: number;
  limit?: number;
}): Promise<{ found: number; reEmitted: number }> {
  const now = deps.now ?? new Date();
  const graceMinutes = deps.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const maxAgeHours = deps.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const limit = deps.limit ?? DEFAULT_LIMIT;

  const newestQueuedAt = new Date(now.getTime() - graceMinutes * 60_000);
  const oldestQueuedAt = new Date(now.getTime() - maxAgeHours * 3_600_000);

  const stale = await deps.prisma.notification.findMany({
    where: {
      status: "queued",
      createdAt: { gte: oldestQueuedAt, lt: newestQueuedAt },
    },
    select: { id: true, teacherId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let reEmitted = 0;
  for (const n of stale) {
    // emit is itself best-effort (swallows its own errors); a single bad row
    // must not wedge the batch, so count only what we attempted to re-drive.
    await deps.emit({ notificationId: n.id, teacherId: n.teacherId });
    reEmitted += 1;
  }

  return { found: stale.length, reEmitted };
}
