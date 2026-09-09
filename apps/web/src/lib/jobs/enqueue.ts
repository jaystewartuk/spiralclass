import type { SendOptions } from "pg-boss";
import { inngest, type Events } from "@/lib/inngest/client";
import { jobsBackend } from "@/lib/env";
import { getBoss } from "./boss";

// Phase 0 scaffold (docs/architecture/overview.md):
// the provider-agnostic seam producers will eventually call instead of
// `inngest.send` directly. Not yet wired into any call site — today's ~73
// `inngest.send`/`emitNotificationQueued` producers are untouched, so this
// file changes no behaviour on its own. Phase 2 is "flip producers to
// enqueue onto pg-boss (behind the flag)"; having the seam land now means
// that phase edits call sites once, not twice.
//
// `name`/`data` are typed against the same `Events` map the Inngest client
// already uses, so a future producer swap is a like-for-like substitution.
//
// Only the options meaningful to a delayed/deduped job queue are exposed —
// `startAfter` (delay) and `singletonKey` (dedup), named after their pg-boss
// `SendOptions` equivalents. BOTH are honoured on the Inngest path too, via
// the event payload's own fields:
//   * `startAfter` → `ts`. An event whose `ts` is in the future schedules the
//     function RUN to start at that time ("same effect as step.sleepUntil at
//     the start of the function", per Inngest's delayed-functions guide) — the
//     delayed-delivery primitive the reminder wake chain runs on
//     (lib/notifications/reminder-scan.ts). Distinct from the in-run
//     `step.sleep` durability that only exists inside a function. Capped at
//     SEVEN DAYS on Inngest's free plan (a year on paid); every wake this seam
//     schedules is <= ~65 min out, so the cap is not close. Note it does NOT
//     apply to a function already waiting on an event — those resume at once.
//   * `singletonKey` → `id`, Inngest's idempotency key: a second event with
//     the same id inside 24h invokes nothing. Wake times are always <= ~65 min
//     out, so that window comfortably covers the overlap between two ticks
//     scheduling the same moment.
// A `startAfter` given as a number is seconds-from-now (pg-boss's own
// convention); a Date or ISO string is an absolute moment.
export type EnqueueOptions = Pick<SendOptions, "startAfter" | "singletonKey">;

// pg-boss accepts `Date | string | number`; Inngest wants epoch millis. Returns
// undefined for "no delay" so the field is simply absent from the payload.
function tsFrom(startAfter: EnqueueOptions["startAfter"]): number | undefined {
  if (startAfter === undefined) return undefined;
  if (typeof startAfter === "number") return Date.now() + startAfter * 1000;
  const at = startAfter instanceof Date ? startAfter : new Date(startAfter);
  const ms = at.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export async function enqueue<K extends keyof Events>(
  name: K,
  data: Events[K]["data"],
  opts?: EnqueueOptions,
): Promise<void> {
  if (jobsBackend() === "pgboss") {
    await (await getBoss()).send(name, data, opts);
    return;
  }
  const ts = tsFrom(opts?.startAfter);
  await inngest.send({
    name,
    data,
    ...(ts === undefined ? {} : { ts }),
    ...(opts?.singletonKey === undefined ? {} : { id: opts.singletonKey }),
  });
}

// Adapter for producers whose injected emitter takes a pre-built
// `{ name, data }` event object (the webhook / booking / reconcile emitters).
// Lets a call site pass `emit: enqueueEvent` in place of
// `emit: (e) => inngest.send(e)` — same routing, provider-agnostic.
export async function enqueueEvent<K extends keyof Events>(
  event: { name: K; data: Events[K]["data"] },
  opts?: EnqueueOptions,
): Promise<void> {
  await enqueue(event.name, event.data, opts);
}

// Mirrors lib/notifications/events.ts's emitNotificationQueued — same event,
// same payload shape — so a future call-site swap is mechanical. Not called
// by that module yet (see the file-level note above).
export async function enqueueNotification(
  notificationId: string,
  teacherId: string,
): Promise<void> {
  await enqueue("notification.queued", { notificationId, teacherId });
}
