import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { handleResendWebhook, verifyResendSignature } from "@/lib/notifications/email-webhook";
import { logger, correlationIdFrom } from "@/lib/logger";

// Resend delivery receipts. Until this existed, an email notification's
// terminal state was `sent` — meaning only that Resend's API returned an id —
// and `delivered`/`failed` were written for push and nothing else. See the
// comment at the top of lib/notifications/email-webhook.ts for the incident
// that made the gap visible.
//
// Same shape as the Stripe receiver: verify the signature, then always 200
// once handled or deliberately skipped, so the provider stops retrying. A 4xx
// is reserved for a signature that does not verify.

export async function POST(req: NextRequest): Promise<Response> {
  const env = serverEnv();
  const rawBody = await req.text();
  const log = logger({ surface: "resend-webhook", correlationId: correlationIdFrom(req) });

  const secret = env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const verified = verifyResendSignature({
      headers: {
        id: req.headers.get("svix-id"),
        timestamp: req.headers.get("svix-timestamp"),
        signature: req.headers.get("svix-signature"),
      },
      rawBody,
      secret,
    });
    if (!verified.ok) {
      log.warn("signature rejected", { reason: verified.reason });
      return new NextResponse("invalid signature", { status: 401 });
    }
  } else if (env.NODE_ENV === "production") {
    // Refuse rather than accept unsigned traffic on a public endpoint that
    // writes to notification rows.
    log.error("FATAL: no RESEND_WEBHOOK_SECRET configured in production");
    return new NextResponse("webhook not configured", { status: 503 });
  } else {
    log.warn("skipping signature verification (no RESEND_WEBHOOK_SECRET)");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, code: "unparseable-body" });
  }

  try {
    const outcome = await handleResendWebhook(payload, { prisma });
    log.info("handled", { code: outcome.code });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    log.error("resend webhook handler threw", err);
    // 500 so Resend retries — a transient DB error should not silently lose a
    // delivery receipt.
    return new NextResponse("handler error", { status: 500 });
  }
}
