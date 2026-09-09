import { createT } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { billingPriceIds, hasBillingCreds, serverEnv } from "@/lib/env";
import { getStripeClient } from "@/lib/stripe";
import { stripeTaxEnabled } from "@/lib/stripe/tax";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { ensureSubscriptionForTeacher, getFoundingCohortState } from "./service";
import { entitlementsFor } from "./entitlements";
import type { SubscriptionPlan } from "./config";

const log = logger({ surface: "billing-checkout" });

// Service behind the "Upgrade to Pro" flow: the TEACHER's own subscription,
// billed on the platform account. Platform secret key only, no `Stripe-Account`
// header — this is the one charge in the product that really IS the platform's,
// and it must never be confused with a lesson payment, which since D-143
// belongs entirely to her (see lib/stripe/client.ts).
//
// ── Who gets billed (rebuilt at D-143) ────────────────────────────────────
//
// Her v2 `Account` IS the billing customer. Accounts v2 lets one object carry
// both a `merchant` configuration (she takes her students' payments) and a
// `customer` configuration (we bill her), so there is no separate `Customer`
// object and no Account-to-Customer mapping table to keep in step — which is
// the concrete reason D-143 chose Accounts v2 over v1 Standard.
//
// `teacher_subscriptions.stripe_customer_id` stores whichever id we bill:
//   * `acct_…` — her Account (every subscription created since D-143)
//   * `cus_…`  — a legacy platform Customer, from before the cutover
// Both are honoured on every read; only `acct_` is ever written now. The column
// keeps its name deliberately: it has always meant "the thing we bill", and a
// migration to rename it would touch history for no behavioural gain.

export type StartBillingCheckoutArgs = {
  teacherId: string;
  plan: Exclude<SubscriptionPlan, "free">;
  locale: AppLocale;
  // "hosted" (default): redirect to a Stripe-hosted Checkout page. "embedded":
  // mint a client_secret for Embedded Checkout so the upgrade renders inline in
  // Settings. The Customer Portal has no embedded variant — Stripe only offers
  // it hosted — so startBillingPortal always returns the "redirect" shape.
  uiMode?: "hosted" | "embedded";
};

/**
 * A stable, language-free identifier for each way this can fail.
 *
 * The localized sentence is for rendering; this is for anything that has to
 * SURVIVE a round trip. `openBillingPortal` redirects back to the settings
 * page with the failure in the query string, and putting the sentence there
 * meant the URL carried prose in whatever language she was reading at the
 * moment it failed — still there, still in the old language, after she
 * switched. The sibling payments page has passed a code and translated on
 * arrival since it shipped; this brings billing onto the same convention.
 */
export type BillingErrorCode =
  | "unavailable"
  | "account-not-found"
  | "already-subscribed"
  | "already-comped"
  | "founding-closed"
  | "plan-not-configured"
  | "no-payment-form"
  | "no-checkout-link"
  | "no-subscription"
  | "unexpected";

export type StartBillingCheckoutResult =
  | { mode: "redirect"; redirectTo: string }
  | { mode: "embedded"; clientSecret: string }
  | { error: string; code: BillingErrorCode };

const PRICE_ENV_BY_PLAN = {
  monthly: "STRIPE_PRICE_MONTHLY",
  annual: "STRIPE_PRICE_ANNUAL",
  founding: "STRIPE_PRICE_FOUNDING",
} as const;

/**
 * The Stripe id to bill this teacher against, creating one if she has none.
 *
 * Order matters, and the middle branch is the point of the whole design: a
 * teacher who already has a connected account is billed against THAT account
 * rather than a second object, because it already carries the `customer`
 * configuration alongside `merchant`.
 *
 * A teacher with no connected account still has to be billable — she may be in
 * a country Stripe refuses as a merchant (IN, ZA, NG, ID, IS), or simply not
 * have connected yet. She gets a `customer`-configuration-only Account, which
 * Stripe accepts for those countries.
 */
async function ensureBillingAccountId(teacher: {
  id: string;
  email: string;
  name: string;
  country: string;
  stripeAccountId: string | null;
}): Promise<{ customerAccountId?: string; customerId?: string }> {
  const sub = await ensureSubscriptionForTeacher(teacher.id);

  if (sub.stripeCustomerId) {
    // Legacy subscribers keep their platform Customer; everyone since D-143
    // has an `acct_`. Branch on the prefix rather than a stored flag — the id
    // itself is unambiguous and cannot drift out of sync with a column.
    return sub.stripeCustomerId.startsWith("cus_")
      ? { customerId: sub.stripeCustomerId }
      : { customerAccountId: sub.stripeCustomerId };
  }

  const billingAccountId =
    teacher.stripeAccountId ??
    (
      await getStripeClient().createCustomerAccount({
        email: teacher.email,
        country: teacher.country,
        businessName: teacher.name,
      })
    ).id;

  await prisma.teacherSubscription.update({
    where: { teacherId: teacher.id },
    data: { stripeCustomerId: billingAccountId },
  });
  return { customerAccountId: billingAccountId };
}

export async function startBillingCheckout(
  args: StartBillingCheckoutArgs,
): Promise<StartBillingCheckoutResult> {
  const t = createT(args.locale);
  if (!hasBillingCreds()) {
    return { error: t("billing.error.unavailable"), code: "unavailable" };
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: args.teacherId },
    select: { id: true, email: true, name: true, country: true, stripeAccountId: true },
  });
  if (!teacher) {
    return { error: t("billing.error.accountNotFound"), code: "account-not-found" };
  }

  // NEVER SELL A SECOND SUBSCRIPTION TO SOMEONE WHO ALREADY HAS ONE.
  //
  // Nothing here used to check, and the UI was the only thing standing between
  // a teacher and paying twice — which is not a boundary. Stripe's idempotency
  // key is keyed on (teacher, price), so it dedupes a double-click on the SAME
  // plan and does nothing at all for a different one: monthly, then annual from
  // a stale second tab, is two Checkout Sessions, two live subscriptions, and
  // two charges a month with no code path that reconciles them.
  //
  // Keyed on the effective STATUS rather than on `stripeSubscriptionId` being
  // present, because `dropToFree` deliberately leaves that id on the row: a
  // teacher who cancelled and lapsed still carries her old subscription id, and
  // an id-presence check would lock her out of ever coming back.
  const existing = await ensureSubscriptionForTeacher(teacher.id);
  const entitlements = entitlementsFor(existing);
  if (entitlements.comped) {
    return { error: t("billing.error.alreadyComped"), code: "already-comped" };
  }
  if (
    existing.stripeSubscriptionId &&
    (entitlements.status === "active" || entitlements.status === "past_due")
  ) {
    // past_due is included on purpose: the answer to a failed payment is a new
    // card in the portal, never a second subscription beside the unpaid one.
    return { error: t("billing.error.alreadySubscribed"), code: "already-subscribed" };
  }

  // Founding is offered only while the cohort is open (cap AND cutoff).
  if (args.plan === "founding") {
    const cohort = await getFoundingCohortState();
    if (!cohort.isOpen) {
      return { error: t("billing.error.foundingClosed"), code: "founding-closed" };
    }
  }

  const priceId = billingPriceIds()[args.plan];
  if (!priceId) {
    // The env var name is logged, not shown: it means nothing to a teacher and
    // names our infrastructure to whoever is looking. The old copy put
    // `STRIPE_PRICE_FOUNDING` on screen, in Spanish only, beside an
    // untranslated plan id.
    log.error("billing price id missing", {
      plan: args.plan,
      envVar: PRICE_ENV_BY_PLAN[args.plan],
    });
    return { error: t("billing.error.planNotConfigured"), code: "plan-not-configured" };
  }

  const billTo = await ensureBillingAccountId(teacher);

  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const uiMode = args.uiMode ?? "hosted";
  const session = await getStripeClient().createBillingCheckoutSession({
    ...billTo,
    priceId,
    clientReferenceId: teacher.id,
    uiMode,
    // She already had a 30-day in-app Pro trial; the subscription charges
    // immediately on upgrade (no second Stripe trial).
    ...(uiMode === "embedded"
      ? { returnUrl: `${appUrl}/settings/billing?upgraded=1` }
      : {
          successUrl: `${appUrl}/settings/billing?upgraded=1`,
          cancelUrl: `${appUrl}/settings/billing?canceled=1`,
        }),
    metadata: { teacher_id: teacher.id, plan: args.plan },
    automaticTax: stripeTaxEnabled(),
    // Shows a promo-code field on the hosted page. Codes are created in the
    // Stripe Dashboard; this flag alone creates no discount.
    allowPromotionCodes: true,
  });

  trackServerEvent({
    name: "subscription_checkout_started",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, plan: args.plan },
  });

  if (uiMode === "embedded") {
    if (!session.client_secret) {
      return { error: t("billing.error.noPaymentForm"), code: "no-payment-form" };
    }
    return { mode: "embedded", clientSecret: session.client_secret };
  }
  if (!session.url) {
    return { error: t("billing.error.noCheckoutLink"), code: "no-checkout-link" };
  }
  return { mode: "redirect", redirectTo: session.url };
}

// Customer Portal session: update the card, or cancel at period end (no
// proration). Hosted only — Stripe offers no embedded variant.
export async function startBillingPortal(
  teacherId: string,
  locale: AppLocale,
): Promise<StartBillingCheckoutResult> {
  const t = createT(locale);
  if (!hasBillingCreds()) {
    return { error: t("billing.error.portalUnavailable"), code: "unavailable" };
  }
  const sub = await prisma.teacherSubscription.findUnique({
    where: { teacherId },
    select: { stripeCustomerId: true },
  });
  // Deliberately does NOT create one: with nothing to manage, the portal would
  // open on an empty account and read as a bug. The upgrade flow is what mints
  // the billing account.
  if (!sub?.stripeCustomerId) {
    return { error: t("billing.error.noSubscriptionToManage"), code: "no-subscription" };
  }
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const session = await getStripeClient().createBillingPortalSession({
    ...(sub.stripeCustomerId.startsWith("cus_")
      ? { customerId: sub.stripeCustomerId }
      : { customerAccountId: sub.stripeCustomerId }),
    returnUrl: `${appUrl}/settings/billing`,
    // The configuration this repo declares, when it has been synced (see
    // lib/stripe/portal-configuration.ts). Without it Stripe opens its own
    // lazily-created default, where plan switching is off and the cancel policy
    // is whatever the Dashboard last said.
    configurationId: serverEnv().STRIPE_BILLING_PORTAL_CONFIG_ID,
  });
  return { mode: "redirect", redirectTo: session.url };
}
