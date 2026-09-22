import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { wiseClientForTeacher } from "@/lib/wise/api";
import { reconcileWiseStatements } from "@/lib/payments/wise-reconcile";

// Hourly: for each teacher who connected their own Wise Business API
// credentials, pull incoming credits off THAT teacher's balance statement
// and auto-confirm THEIR pending payments whose reference + amount match.
// No-ops cleanly when no teacher is connected — Wise then stays in
// teacher-confirmed mode.
//
// Pure matcher + per-teacher orchestrator live in
// src/lib/payments/wise-reconcile.ts; the SCA-signed statement read + the
// per-teacher client factory live in src/lib/wise/api.ts. This wrapper only
// wires prisma + the client factory + the Inngest emitter together, the same
// shape as the other polling crons (poll-push-receipts).
//
// retries:1 — a transient Wise 5xx/SCA hiccup gets one more shot; the next
// tick would catch it anyway, and confirmTransferPayment is idempotent so a
// double-run can't double-confirm.

export const pollWiseStatementsCronFn = inngest.createFunction(
  {
    id: "poll-wise-statements-cron",
    retries: 1,
    // Hourly, on the shared :00 wake grid — every cron minute off it opens its
    // own 5-minute Neon wake window (lib/env.ts isPreviewDeployment). Was */15
    // until D-115; a teacher's own Wise credit still auto-confirms unattended,
    // just within the hour rather than the quarter-hour.
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("poll-wise-statements", () =>
      reconcileWiseStatements({
        prisma,
        clientForTeacher: wiseClientForTeacher,
        emit: async (event) => {
          await inngest.send(event);
        },
      }),
    ),
);
