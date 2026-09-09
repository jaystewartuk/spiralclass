import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { billingPriceIds, serverEnv } from "@/lib/env";
import { getStripeClient } from "@/lib/stripe";
import { verifyWebhookSignature } from "@/lib/stripe/signature";
import { handleBillingWebhook } from "@/lib/subscriptions/billing-webhook-handler";
import { inngest } from "@/lib/inngest/client";
import {
  markWebhookEventProcessed,
  recordWebhookEvent,
  releaseWebhookEvent,
} from "@/lib/webhooks/idempotency";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { logger, correlationIdFrom } from "@/lib/logger";

// Stripe BILLING webhook receiver — the teacher's own platform subscription.
// SEPARATE endpoint + secret from the Connect webhook (/api/stripe/webhook):
// signature-verified with STRIPE_BILLING_WEBHOOK_SECRET, idempotent via
// WebhookEvent, canonical state re-fetched from Stripe in the handler. Drives
// the subscription lifecycle transitions (active / past_due / canceled / free).

export async function POST(req: NextRequest): Promise<Response> {
  const env = serverEnv();
  const rawBody = await req.text();
  const log = logger({ surface: "billing-webhook", correlationId: correlationIdFrom(req) });

  if (env.STRIPE_BILLING_WEBHOOK_SECRET) {
    const signatureCheck = verifyWebhookSignature({
      signatureHeader: req.headers.get("stripe-signature"),
      rawBody,
      secret: env.STRIPE_BILLING_WEBHOOK_SECRET,
    });
    if (!signatureCheck.ok) {
      log.warn("signature rejected", { reason: signatureCheck.reason });
      return new NextResponse("invalid signature", { status: 401 });
    }
  } else if (env.NODE_ENV === "production") {
    log.error("FATAL: STRIPE_BILLING_WEBHOOK_SECRET not configured in production");
    return new NextResponse("webhook not configured", { status: 503 });
  } else {
    log.warn("skipping signature verification (no STRIPE_BILLING_WEBHOOK_SECRET)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, code: "unparseable-body" });
  }

  const eventId =
    parsed && typeof parsed === "object" && "id" in parsed
      ? String((parsed as { id?: unknown }).id ?? "")
      : "";
  const eventType =
    parsed && typeof parsed === "object" && "type" in parsed
      ? String((parsed as { type?: unknown }).type ?? "")
      : null;
  // Insert-first claim, namespaced per-endpoint. Both Stripe webhook endpoints
  // record into one WebhookEvent log under provider="stripe"; a Stripe event id
  // is unique only within the set of endpoints subscribed to that event TYPE.
  // If this billing endpoint is ever (mis)configured to receive Connect event
  // types too (e.g. "send all events"), a checkout.session.completed would land
  // here first, claim the bare event id, and the Connect endpoint would then see
  // it as a duplicate and never process the package payment. Prefixing the claim
  // id keeps the two endpoints' namespaces disjoint regardless of Stripe config.
  const claimEventId = `billing:${eventId}`;
  if (eventId) {
    const claim = await recordWebhookEvent(prisma, {
      provider: "stripe",
      eventId: claimEventId,
      eventType,
    });
    if (claim.status === "processed") {
      log.info("duplicate event ignored", { eventId, eventType });
      return NextResponse.json({ ok: true, code: "duplicate-event", eventId });
    }
    if (claim.status === "in_flight") {
      // Fresh unprocessed claim held by another delivery — retry later rather
      // than ack it as done (see the Connect webhook for the rationale).
      log.info("claim in flight; asking for retry", { eventId, eventType });
      return new NextResponse("claim in flight", { status: 409 });
    }
  }

  try {
    const outcome = await handleBillingWebhook(parsed, {
      prisma,
      stripe: getStripeClient(),
      priceIds: billingPriceIds(),
      emit: async (event) => {
        await inngest.send(event);
      },
    });
    // Drain analytics emitted by the lifecycle handler (subscription_activated,
    // subscription_payment_failed, etc.) before the serverless function freezes.
    await flushAnalytics();
    // Mark the claim complete (see the Connect webhook); a crash before this is
    // reclaimed + reprocessed on retry rather than swallowed as a duplicate.
    if (eventId) {
      await markWebhookEventProcessed(prisma, { provider: "stripe", eventId: claimEventId });
    }
    log.info("handled", { eventId, eventType, code: outcome.code });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    if (eventId) {
      await releaseWebhookEvent(prisma, { provider: "stripe", eventId: claimEventId });
    }
    log.error("handler threw", err, { eventId, eventType });
    return new NextResponse("handler error", { status: 500 });
  }
}
