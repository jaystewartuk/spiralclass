import Stripe from "stripe";
import { STRIPE_API_VERSION } from "./client";

// Verifies a Stripe webhook signature via the official SDK's
// `stripe.webhooks.constructEvent`, which implements
// https://stripe.com/docs/webhooks/signatures (HMAC-SHA256 over
// `${timestamp}.${rawBody}`, timing-safe compare, tolerance window) —
// maintained by Stripe rather than hand-rolled here.
//
// The route MUST pass the unmodified raw body — any whitespace or
// re-serialization invalidates the signature.

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: "missing-header" | "malformed-header" | "stale" | "mismatch" };

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

// Webhook signature verification is pure local crypto (HMAC), never a
// network call — the secret key here is unused and never sent anywhere, so
// a placeholder is safe. Constructed once per module (not per-call).
const stripe = new Stripe("sk_webhook_signature_helper_unused", {
  apiVersion: STRIPE_API_VERSION,
});

export function verifyWebhookSignature(input: {
  signatureHeader: string | null | undefined;
  rawBody: string;
  secret: string;
  toleranceSeconds?: number;
}): SignatureVerification {
  if (!input.signatureHeader) return { ok: false, reason: "missing-header" };

  try {
    stripe.webhooks.constructEvent(
      input.rawBody,
      input.signatureHeader,
      input.secret,
      input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      // Message strings are stable across the SDK's own test suite; see
      // node_modules/stripe/cjs/Webhooks.js for the source of truth.
      if (err.message.includes("Unable to extract timestamp and signatures")) {
        return { ok: false, reason: "malformed-header" };
      }
      if (err.message.includes("No signatures found with expected scheme")) {
        return { ok: false, reason: "malformed-header" };
      }
      if (err.message.includes("Timestamp outside the tolerance zone")) {
        return { ok: false, reason: "stale" };
      }
      return { ok: false, reason: "mismatch" };
    }
    throw err;
  }
}

// Helper for tests + the local fixture script: produce a header that
// passes verifyWebhookSignature for the given body.
export function signWebhookBody(input: {
  rawBody: string;
  secret: string;
  timestampSeconds?: number;
}): string {
  return stripe.webhooks.generateTestHeaderString({
    payload: input.rawBody,
    secret: input.secret,
    timestamp: input.timestampSeconds ?? Math.floor(Date.now() / 1000),
  });
}
