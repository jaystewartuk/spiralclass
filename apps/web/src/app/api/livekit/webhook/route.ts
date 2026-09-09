import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  markWebhookEventProcessed,
  recordWebhookEvent,
  releaseWebhookEvent,
} from "@/lib/webhooks/idempotency";
import { getVideoProvider } from "@/lib/video/provider";
import { handleNormalizedEvent } from "@/lib/video/webhook-events";

// Video-provider webhook — the async completion signal for lesson-insights
// Phase A and for
// finalizing room-composite recordings. Stays at /api/livekit/webhook (LiveKit
// Cloud's dashboard is already configured against this exact URL — renaming it
// is unnecessary churn while LiveKit is the only provider) even though the
// handling itself is now provider-agnostic, per
// docs/features/live-calls-video.md. Signature
// verification and event normalization are the active provider's job
// (parseWebhookEvent); this route only owns dedup (the shared webhook_events
// log, like stripe/meta) and dispatching the normalized event to
// lib/video/webhook-events.ts.
//
// This is a service-role surface; it resolves the teacher via the booking,
// never trusts a client.

const log = logger({ surface: "livekit-webhook" });

export async function POST(req: NextRequest): Promise<Response> {
  const provider = getVideoProvider();
  if (!provider) {
    // No provider configured → nothing could have produced a signed callback.
    // Mirror the other webhook routes: 503 so a misconfig is obvious.
    log.warn("video provider not configured");
    return new NextResponse("webhook not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const authHeader = req.headers.get("Authorization");

  let parsed;
  try {
    parsed = await provider.parseWebhookEvent(rawBody, authHeader);
  } catch (err) {
    log.warn("signature rejected", { reason: String(err) });
    return new NextResponse("invalid signature", { status: 401 });
  }

  const claim = await recordWebhookEvent(prisma, {
    provider: provider.id,
    eventId: parsed.eventId,
    eventType: parsed.eventType,
  });
  if (claim.status === "processed") {
    return NextResponse.json({ ok: true, code: "duplicate-event" });
  }
  if (claim.status === "in_flight") {
    // Another delivery holds a fresh unprocessed claim — retry later rather
    // than ack it as done (see the Stripe webhook for the rationale).
    return new NextResponse("claim in flight", { status: 409 });
  }

  try {
    const outcome = await handleNormalizedEvent(prisma, parsed.event);
    await markWebhookEventProcessed(prisma, { provider: provider.id, eventId: parsed.eventId });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    await releaseWebhookEvent(prisma, { provider: provider.id, eventId: parsed.eventId });
    log.error("handler threw", err, { eventType: parsed.eventType });
    return new NextResponse("handler error", { status: 500 });
  }
}
