"use server";

import { redirect } from "next/navigation";
import { createT } from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import {
  startBillingCheckout,
  startBillingPortal,
} from "@/lib/subscriptions/start-billing-checkout";
import { flushAnalytics } from "@/lib/analytics/posthog";
import type { SubscriptionPlan } from "@/lib/subscriptions/config";
import { hasStripeEmbeddedCheckout } from "@/lib/env";

// Card upgrades render inline via Embedded Checkout; on success the state
// carries the Checkout Session's client_secret instead of redirecting.
export type BillingActionState = { error?: string } | { clientSecret: string } | undefined;

// Start the subscription-mode Stripe Checkout for the chosen plan. A PLATFORM
// charge on the platform account — never Connect, and never confused with a
// lesson payment, which belongs to the teacher (D-143).
export async function startSubscriptionCheckout(
  _prev: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const planRaw = String(formData.get("plan") ?? "");
  // Validated here rather than cast: `plan` arrives from a client form, and a
  // bad value would otherwise reach billingPriceIds() as an undefined lookup.
  if (planRaw !== "monthly" && planRaw !== "annual" && planRaw !== "founding") {
    return { error: createT(locale)("billing.error.pickPlan") };
  }
  const plan = planRaw as Exclude<SubscriptionPlan, "free">;
  const result = await startBillingCheckout({
    teacherId: teacher.id,
    plan,
    locale,
    uiMode: hasStripeEmbeddedCheckout() ? "embedded" : "hosted",
  });
  if ("error" in result) return { error: result.error };
  // Drain subscription_checkout_started before the redirect/return — a
  // redirect ends the request and would strand a buffered event.
  await flushAnalytics();
  if (result.mode === "embedded") return { clientSecret: result.clientSecret };
  redirect(result.redirectTo);
}

// Open the Stripe Customer Portal (update card / cancel at period end).
// Hosted-only — Stripe has no embedded Customer Portal.
export async function openBillingPortal(): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const result = await startBillingPortal(teacher.id, locale);
  // The CODE travels, not the sentence. A localized message in the query string
  // is prose in the URL bar, and it stays in the language she was reading when
  // it failed even after she switches — the settings page translates the code
  // on arrival instead, the same way its payments sibling always has.
  if ("error" in result) {
    redirect(`/settings/billing?error=${result.code}`);
  }
  // startBillingPortal always resolves "redirect" mode — the Customer Portal
  // has no embedded variant — but the shared result type is a union with the
  // Checkout-only "embedded" case, so narrow explicitly rather than asserting.
  if (result.mode !== "redirect") {
    redirect(`/settings/billing?error=unexpected`);
  }
  redirect(result.redirectTo);
}
