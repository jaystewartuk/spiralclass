"use server";

import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { currencyForTeacher, isConnectCountrySupported } from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serverEnv, hasStripeCreds } from "@/lib/env";
import {
  getStripeClient,
  isStripeAccountUnreachableError,
  isStripeConnectNotEnabledError,
} from "@/lib/stripe";
import { maybeEmitMarketplaceReady } from "@/lib/marketplace-ready";
import { revalidateAfterAction } from "@/lib/revalidate";

// Server actions powering /settings/payments. Stripe Connect Express:
//   1. `startStripeConnect` — creates an Express account on first call
//      (idempotent if one already exists for the teacher), generates a
//      one-shot Account Link, and redirects the teacher to Stripe's
//      hosted onboarding pages. Kept as the fallback when the browser
//      publishable key isn't configured (hasStripeEmbeddedCheckout() false).
//   2. `startEmbeddedConnectOnboarding` — same account-creation/gating as
//      above (shared via ensureConnectedAccount below) but returns an
//      Account Session client_secret instead of redirecting, for
//      @stripe/react-connect-js's embedded onboarding component rendered
//      inline in Settings. Same trigger point, same country gate, same
//      entry conditions as (1) — only the rendering technology (embedded
//      vs. hosted-redirect) differs.
//   3. `disconnectStripeConnect` — clears the teacher's
//      stripe_account_id and capability flags. The connected account
//      itself is NOT deleted from Stripe (Stripe retains it for tax
//      records); the platform just stops using it.

type EnsureConnectedAccountResult =
  | { status: "ready"; accountId: string }
  // Dev-only stub path (no real Stripe creds, non-production): the account
  // is already fully "connected" — no onboarding UI (link or embedded) to
  // show.
  | { status: "dev-stub-connected" }
  | {
      status: "error";
      error:
        "country-unsupported" | "stripe-disabled" | "connect-not-enabled" | "account-unreachable";
    };

async function ensureConnectedAccount(teacher: {
  id: string;
  email: string;
  name: string;
  country: string;
  // Her settlement currency, fixed on the connected account at creation and
  // never changeable afterwards — the same one-way door as `country` (D-143).
  pricingCurrency?: string | null;
  stripeAccountId: string | null;
}): Promise<EnsureConnectedAccountResult> {
  // Soft country gate. Stripe fixes a connected account's country at creation
  // and never lets it change, so we refuse to mint an account for a country the
  // platform can't currently pay out to (SUPPORTED_CONNECT_COUNTRIES) — that
  // would strand the teacher with a permanently-unpayable account
  // (`transfers_not_allowed`). Non-supported teachers use the country-agnostic
  // Wise rail instead; the settings page renders the coming-soon state.
  if (!isConnectCountrySupported(teacher.country)) {
    return { status: "error", error: "country-unsupported" };
  }

  // Stripe Connect requires real creds to actually onboard a teacher.
  // In production with no creds this is an error — the settings UI hides
  // the Stripe card entirely so this branch is only reachable via a stale
  // URL. In dev we keep the stub behavior so the local flow works without
  // Stripe.
  if (!hasStripeCreds()) {
    if (serverEnv().NODE_ENV === "production") {
      return { status: "error", error: "stripe-disabled" };
    }
    await prisma.teacher.update({
      where: { id: teacher.id },
      data: {
        stripeAccountId: "acct_STUB_DEV",
        stripeAccountLinkedAt: new Date(),
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });
    await maybeEmitMarketplaceReady(prisma, teacher.id);
    return { status: "dev-stub-connected" };
  }

  const stripe = getStripeClient();
  let accountId = teacher.stripeAccountId;
  if (!accountId) {
    let account;
    try {
      account = await stripe.createConnectedAccount({
        email: teacher.email,
        country: teacher.country,
        currency: currencyForTeacher(teacher),
        businessName: teacher.name,
        // One account per teacher, however many times this races.
        idempotencyKey: `connect-account-${teacher.id}`,
      });
    } catch (err) {
      if (isStripeConnectNotEnabledError(err)) {
        Sentry.captureMessage("Stripe Connect not enabled on platform account", {
          level: "warning",
          tags: { surface: "stripe-connect", reason: "platform-not-onboarded" },
        });
        return { status: "error", error: "connect-not-enabled" };
      }
      throw err;
    }
    accountId = account.id;
    // Guarded persist, belt to the idempotency key's braces. The key stops
    // Stripe minting duplicates; this stops US overwriting an id another
    // concurrent request already wrote. If someone else won, adopt THEIR id
    // rather than ours — with a stable key the two are the same account, and
    // if they ever are not, the stored one is the one the rest of the app has
    // already seen.
    const claimed = await prisma.teacher.updateMany({
      where: { id: teacher.id, stripeAccountId: null },
      data: {
        stripeAccountId: accountId,
        stripeAccountLinkedAt: new Date(),
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
      },
    });
    if (claimed.count === 0) {
      const winner = await prisma.teacher.findUnique({
        where: { id: teacher.id },
        select: { stripeAccountId: true },
      });
      if (winner?.stripeAccountId) accountId = winner.stripeAccountId;
    }
    // charges_enabled is virtually always false on a freshly created Express
    // account (KYC hasn't run yet) — this re-check is here for the rare case
    // Stripe pre-approves one, not the primary path. The primary path is the
    // return/webhook handlers below, after the teacher completes onboarding.
    await maybeEmitMarketplaceReady(prisma, teacher.id);
  }

  return { status: "ready", accountId };
}

// A stored `stripe_account_id` this platform cannot act on, surfaced from
// whichever call first used it (account_sessions for the embedded flow,
// account_links for the redirect fallback).
//
// The deliberate non-response is to mint a replacement. It is the obvious
// "self-healing" move and it is wrong twice over: account creation under
// D-143's configuration is IRREVERSIBLE — Stripe refuses both
// DELETE /v1/accounts and the v2 close endpoint for
// `losses_collector: "stripe"` accounts, so every extra account is permanent
// (PR 948) — and the id is usually unreachable because it is the teacher's OWN
// pre-existing account (PR 946), where silently creating a second one is the
// confusion, not the cure. So this reports and stops. Clearing the pointer is
// an operator action through the existing disconnect control, taken once
// someone has looked at which account the id actually is.
function reportUnreachableAccount(teacherId: string, accountId: string): void {
  Sentry.captureMessage("Stripe connected account unreachable from platform", {
    level: "warning",
    tags: { surface: "stripe-connect", reason: "account-unreachable" },
    extra: { teacherId, accountId },
  });
}

export async function startStripeConnect(): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const result = await ensureConnectedAccount(teacher);
  if (result.status === "error") {
    redirect(`/settings/payments?error=${result.error}`);
  }
  if (result.status === "dev-stub-connected") {
    redirect("/settings/payments?connected=1");
  }

  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  // Only the Stripe call is inside the try — `redirect()` signals by throwing,
  // so wrapping it too would swallow the navigation.
  let link;
  try {
    link = await getStripeClient().createAccountLink({
      accountId: result.accountId,
      type: "account_onboarding",
      returnUrl: `${appUrl}/api/stripe/connect/return?account=${encodeURIComponent(result.accountId)}`,
      refreshUrl: `${appUrl}/api/stripe/connect/return?account=${encodeURIComponent(result.accountId)}&refresh=1`,
    });
  } catch (err) {
    if (isStripeAccountUnreachableError(err)) {
      reportUnreachableAccount(teacher.id, result.accountId);
      redirect("/settings/payments?error=account-unreachable");
    }
    throw err;
  }
  redirect(link.url);
}

export type StartEmbeddedConnectResult =
  { clientSecret: string } | { connected: true } | { error: string };

// Called from a client component (stripe-connect-embedded.tsx), not bound to
// a <form> — returns a value instead of redirecting so the caller can mount
// @stripe/react-connect-js's ConnectAccountOnboarding inline. Only reachable
// when hasStripeEmbeddedCheckout() gates the client to render this path
// instead of the startStripeConnect form fallback.
export async function startEmbeddedConnectOnboarding(): Promise<StartEmbeddedConnectResult> {
  const teacher = await requireOnboardedTeacher();
  const result = await ensureConnectedAccount(teacher);
  if (result.status === "error") return { error: result.error };
  if (result.status === "dev-stub-connected") return { connected: true };

  try {
    const session = await getStripeClient().createAccountSession({
      accountId: result.accountId,
      components: { accountOnboarding: true },
    });
    return { clientSecret: session.client_secret };
  } catch (err) {
    if (isStripeAccountUnreachableError(err)) {
      reportUnreachableAccount(teacher.id, result.accountId);
      return { error: "account-unreachable" };
    }
    throw err;
  }
}

export async function disconnectStripeConnect(): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: {
      stripeAccountId: null,
      stripeAccountLinkedAt: null,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    },
  });
  revalidateAfterAction("/settings/payments");
  redirect("/settings/payments?disconnected=1");
}
