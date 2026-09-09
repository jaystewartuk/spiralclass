import { serverEnv } from "@/lib/env";

// Stripe dashboard prefixes live and test resources at different paths.
// Detected from the secret key prefix so we don't need a separate env var.
function stripeIsTestMode(): boolean {
  const key = serverEnv().STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_test_");
}

function stripeBase(): string {
  return stripeIsTestMode() ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}

export function stripePaymentIntentUrl(paymentIntentId: string | null | undefined): string | null {
  if (!paymentIntentId) return null;
  return `${stripeBase()}/payments/${paymentIntentId}`;
}

export function stripeRefundUrl(refundId: string | null | undefined): string | null {
  if (!refundId) return null;
  return `${stripeBase()}/refunds/${refundId}`;
}

export function stripeConnectedAccountUrl(accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  return `${stripeBase()}/connect/accounts/${accountId}`;
}

export function stripeCheckoutSessionUrl(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return `${stripeBase()}/checkout/sessions/${sessionId}`;
}

// Resend dashboard URLs are not segmented by live/test (all emails are
// listed together). Provider message id format depends on channel — only
// Resend ids start with "re_"; anything else returns null.
export function resendEmailUrl(providerMessageId: string | null | undefined): string | null {
  if (!providerMessageId) return null;
  if (!providerMessageId.startsWith("re_")) return null;
  return `https://resend.com/emails/${providerMessageId}`;
}
