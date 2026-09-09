import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { getStripeClient } from "@/lib/stripe";
import { verifyWebhookSignature } from "@/lib/stripe/signature";
import { handleStripeWebhook } from "@/lib/payments/webhook-handler";
import { enqueueEvent } from "@/lib/jobs/enqueue";
import {
  markWebhookEventProcessed,
  recordWebhookEvent,
  releaseWebhookEvent,
} from "@/lib/webhooks/idempotency";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { logger, correlationIdFrom } from "@/lib/logger";

// Stripe webhook receiver. Refunds: signature is verified; canonical
// resource state comes from re-fetching Stripe's API, never the
// payload. Always 200 once we've handled (or intentionally skipped) so
// Stripe doesn't retry for ~3 days. Genuine 4xx is reserved for
// signature failures (Stripe's docs say to fail those hard).
//
// One of the two places the system uses elevated DB access (the other is
// Inngest jobs, Slice 4). We don't have an authenticated user here; per
// tenant isolation the handler must still filter every query by the resolved
// teacher_id — see webhook-handler.ts.

export async function POST(req: NextRequest): Promise<Response> {
  const env = serverEnv();
  const rawBody = await req.text();
  const log = logger({ surface: "stripe-webhook", correlationId: correlationIdFrom(req) });

  // TWO Stripe event destinations deliver here, each with its own signing
  // secret, and both are required (D-143):
  //   * the PLATFORM destination — carries the v2 account events, including the
  //     one that flips a teacher's charges_enabled when she finishes onboarding
  //   * the CONNECTED-ACCOUNTS destination — carries her students' payments
  // An event is authentic if EITHER secret verifies it; a signature only ever
  // matches the destination that sent it, so accepting both widens nothing.
  // Verifying just one would 401 the other forever — the exact failure that
  // was live on production before this, and which stayed invisible because no
  // Stripe event had ever fired to reveal it.
  const webhookSecrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (s): s is string => Boolean(s),
  );

  if (webhookSecrets.length > 0) {
    const signatureHeader = req.headers.get("stripe-signature");
    const checks = webhookSecrets.map((secret) =>
      verifyWebhookSignature({ signatureHeader, rawBody, secret }),
    );
    if (!checks.some((c) => c.ok)) {
      log.warn("signature rejected", {
        // Every reason, so a misconfiguration is diagnosable: "mismatch" on
        // both means neither secret is right, whereas "missing-header" means
        // the request was not from Stripe at all.
        reasons: checks.map((c) => (c.ok ? "ok" : c.reason)).join(","),
        secretsTried: webhookSecrets.length,
      });
      return new NextResponse("invalid signature", { status: 401 });
    }
  } else if (env.NODE_ENV === "production") {
    log.error("FATAL: no Stripe webhook secret configured in production");
    return new NextResponse("webhook not configured", { status: 503 });
  } else {
    log.warn("skipping signature verification (no Stripe webhook secret)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, code: "unparseable-body" });
  }

  // docs/security.md. Insert-first claim (see idempotency.ts):
  // only the caller that wins the insert runs the handler, so a concurrent or
  // replayed delivery short-circuits before any non-idempotent side effect. On
  // a handler failure we release the claim so Stripe's retry reprocesses.
  const eventId =
    parsed && typeof parsed === "object" && "id" in parsed
      ? String((parsed as { id?: unknown }).id ?? "")
      : "";
  const eventType =
    parsed && typeof parsed === "object" && "type" in parsed
      ? String((parsed as { type?: unknown }).type ?? "")
      : null;
  if (eventId) {
    const claim = await recordWebhookEvent(prisma, { provider: "stripe", eventId, eventType });
    if (claim.status === "processed") {
      log.info("duplicate event ignored", { eventId, eventType });
      return NextResponse.json({ ok: true, code: "duplicate-event", eventId });
    }
    if (claim.status === "in_flight") {
      // Another delivery holds a fresh, not-yet-completed claim. Do NOT ack 200
      // (that would end Stripe's retries and could drop the event if that other
      // attempt has actually died) — 409 so Stripe retries later, by which point
      // the claim is either completed (→ duplicate) or stale (→ reclaimed here).
      log.info("claim in flight; asking for retry", { eventId, eventType });
      return new NextResponse("claim in flight", { status: 409 });
    }
  }

  try {
    const outcome = await handleStripeWebhook(parsed, {
      prisma,
      stripe: getStripeClient(),
      // Provider-agnostic seam (Phase 2b): JOBS_BACKEND routes inngest vs
      // pg-boss. Still best-effort/post-commit — reconcile-paid backstops a
      // lost payment.paid on either backend.
      emit: (event) => enqueueEvent(event),
    });
    // Drain any analytics emitted by the handler (e.g. payment_received) before
    // the serverless function can freeze — posthog-node flushes in the
    // background otherwise and the POST is lost on freeze.
    await flushAnalytics();
    // Mark the claim complete so a later redelivery is a true duplicate. A crash
    // before this leaves the claim unprocessed → a retry reclaims + reprocesses
    // (handlers are idempotent) instead of being swallowed.
    if (eventId) await markWebhookEventProcessed(prisma, { provider: "stripe", eventId });
    log.info("handled", { eventId, eventType, code: outcome.code });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    // Release the claim so Stripe's retry can reprocess instead of being
    // swallowed as a duplicate.
    if (eventId) await releaseWebhookEvent(prisma, { provider: "stripe", eventId });
    log.error("handler threw", err, { eventId, eventType });
    return new NextResponse("handler error", { status: 500 });
  }
}
