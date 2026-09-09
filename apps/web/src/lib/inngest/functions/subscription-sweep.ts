import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { runSubscriptionSweep } from "@/lib/subscriptions/sweep";
import type { LifecycleEmitter } from "@/lib/subscriptions/lifecycle";
import { flushAnalytics } from "@/lib/analytics/posthog";

// Fires the real Inngest event for sweep-driven notifications.
const sweepEmitter: LifecycleEmitter = async (event) => {
  await inngest.send(event);
};

// Daily cron at 14:00 UTC (~08:00 Mexico City). Drives the time-based
// subscription transitions: expired Pro trials → Free, lapsed past_due grace →
// Free, and the one-time "trial ending in ~3 days" nudge. Idempotent. Pure
// handler in src/lib/subscriptions/sweep.ts.
export const subscriptionSweepCronFn = inngest.createFunction(
  {
    id: "subscription-sweep-cron",
    // Daily cadence — a transient failure that exhausts retries would leave
    // expired trials / past-due subs untransitioned for a full day, so allow a
    // few retries rather than one.
    retries: 3,
    triggers: [{ cron: "0 14 * * *" }],
  },
  async ({ step }) => {
    // runSubscriptionSweep drives lifecycle.ts transitions (trial_expired /
    // past_due_grace_elapsed downgrades, etc.), which fire PostHog events with
    // no flush of their own — unlike the billing webhook's equivalent
    // transitions, this cron path is the only caller that never drained them.
    const result = await step.run("run-subscription-sweep", () =>
      runSubscriptionSweep({ prisma, emit: sweepEmitter }),
    );
    await step.run("flush-analytics", () => flushAnalytics());
    return result;
  },
);
