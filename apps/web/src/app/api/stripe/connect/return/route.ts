import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { getStripeClient } from "@/lib/stripe";
import { logger, correlationIdFrom } from "@/lib/logger";
import { maybeEmitMarketplaceReady } from "@/lib/marketplace-ready";

// Stripe redirects the teacher here after onboarding completes (or when
// the Account Link expires — `?refresh=1`). We re-fetch the connected
// account, mirror `charges_enabled` / `payouts_enabled` onto the teacher
// row (so the UI can decide whether to show "ready to receive payments"
// without waiting for the account.updated webhook), and redirect back to
// the settings page.
//
// Failures redirect with `?error=<code>` rather than throwing so the
// teacher sees a readable message.

function errorRedirect(code: string, appUrl: string): Response {
  const url = new URL("/settings/payments", appUrl);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<Response> {
  const log = logger({ surface: "stripe-connect-return", correlationId: correlationIdFrom(req) });
  const env = serverEnv();
  const appUrl = env.APP_URL.replace(/\/$/, "");
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account");
  // `refresh=1` means Stripe sent the
  // teacher here because the Account Link expired or was abandoned before
  // completion, NOT that onboarding finished — previously this was read into
  // the URL but never branched on, so an abandoned flow looked identical to
  // a completed one.
  const isRefresh = url.searchParams.get("refresh") === "1";
  if (!accountId) return errorRedirect("missing-account", appUrl);

  // Verify the account is linked to a teacher (and lives in our DB)
  // before we go any further. Lookups by stripe_account_id stay scoped
  // to teachers we already know about.
  const teacher = await prisma.teacher.findFirst({
    where: { stripeAccountId: accountId },
    select: { id: true },
  });
  if (!teacher) return errorRedirect("unknown-account", appUrl);

  let chargesEnabled = false;
  try {
    const stripe = getStripeClient();
    const account = await stripe.getConnectedAccount(accountId);
    chargesEnabled = account.charges_enabled;
    await prisma.teacher.update({
      where: { id: teacher.id },
      data: {
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        stripeRequirementsDisabledReason: account.requirements?.disabled_reason ?? null,
      },
    });
    // This return trip — the teacher finishing Stripe's hosted KYC — is the
    // realistic primary path a Connect account actually becomes charge-ready,
    // not the account.updated webhook (which can lag) or the account-creation
    // moment (never charge-ready that early). Onboarding activation audit
    // activation audit.
    if (chargesEnabled) await maybeEmitMarketplaceReady(prisma, teacher.id);
  } catch (err) {
    log.warn("account refetch failed", { error: err });
    return errorRedirect("refetch", appUrl);
  }

  const successUrl = new URL("/settings/payments", appUrl);
  // A refresh-triggered return that STILL isn't charge-ready is a genuinely
  // abandoned/incomplete flow — surface that distinctly rather than the
  // generic "connected" notice. If the teacher actually finished (Stripe can
  // send `refresh=1` even when a re-fetch shows completion, e.g. a stale
  // link clicked after finishing elsewhere), treat it as a normal success.
  if (isRefresh && !chargesEnabled) {
    successUrl.searchParams.set("incomplete", "1");
  } else {
    successUrl.searchParams.set("connected", "1");
  }
  return NextResponse.redirect(successUrl);
}
