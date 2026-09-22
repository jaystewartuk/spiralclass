import * as Sentry from "@sentry/nextjs";
import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { anonymizeMaturedDeletions } from "@/lib/account-deletion/anonymize";
import {
  teacherHasUnusedActivePackages,
  studentsHaveUnusedActivePackages,
} from "@/lib/account-deletion/requests";
import { hasStripeCreds } from "@/lib/env";
import { getStripeClient } from "@/lib/stripe";

// docs/security.md.
//
// Daily cron at 04:00 UTC. Picks up account_deletion_requests rows
// in status='pending' whose scheduled_for has elapsed, and runs the
// anonymizer (separate pure module so unit tests can exercise it
// without Inngest).
//
// The grace period is enforced in the request action; the worker
// only checks "is scheduled_for in the past". If we ever extend the
// grace window for a specific subject (e.g. under regulator
// instruction), bumping scheduled_for on the row is enough.

type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

// Exported for unit testing.
export async function accountDeletionHandler({ step }: { step: StepRunner }) {
  return step.run("anonymize-matured", async () => {
    const result = await anonymizeMaturedDeletions({
      prisma,
      now: new Date(),
      // Stop billing a departing Pro teacher. Only wire the canceller when
      // Stripe is configured (Wise-only deploys have no Billing rail);
      // cancel-at-period-end avoids clawing back the already-paid period.
      cancelStripeSubscription: hasStripeCreds()
        ? async (subscriptionId: string) => {
            await getStripeClient().cancelSubscriptionAtPeriodEnd(subscriptionId);
          }
        : undefined,
      // Hard-revoke the deleted account's live better-auth sessions (every
      // device — session rows aren't scoped per-device here), so an
      // already-issued cookie/bearer token can't keep acting after
      // anonymization. Direct Prisma delete, not auth.api.revokeUserSessions:
      // that endpoint requires an authenticated admin SESSION caller
      // (adminMiddleware), which a headless cron job doesn't have — this job
      // is already the trusted, service-role-equivalent actor, same as the
      // old Supabase service-role call it replaces. Best-effort:
      // anonymize.ts surfaces any failure to the result error list.
      revokeAuthSessions: async (authUserId: string) => {
        await prisma.session.deleteMany({ where: { userId: authUserId } });
      },
      // Re-run the request-time money guard at maturity: the account was live
      // through the whole grace window, so a package could have been sold after
      // the request was filed. Never tombstone a subject with unused paid
      // classes — defer instead.
      hasUnusedActivePackages: async (subjectType, subjectId) =>
        subjectType === "teacher"
          ? teacherHasUnusedActivePackages(subjectId)
          : studentsHaveUnusedActivePackages([subjectId]),
    });
    if (result.errors.length > 0) {
      Sentry.captureMessage("[account-deletion] anonymization errors", {
        level: "warning",
        tags: { surface: "account-deletion" },
        extra: result,
      });
    }
    return result;
  });
}

export const accountDeletionCronFn = inngest.createFunction(
  {
    id: "account-deletion-cron",
    retries: 1,
    triggers: [{ cron: "0 4 * * *" }],
  },
  accountDeletionHandler,
);
