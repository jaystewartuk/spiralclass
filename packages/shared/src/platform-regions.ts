// SpiralClass — platform Stripe region registry.
//
// There is exactly ONE platform Stripe entity today, and it is UK-established (D-58).
// It was Mexican at launch, moved to Mexican-company plans that proved
// impractical, then to the UK entity per D-58, and per D-99 the registry
// below now matches that — key `GB`, currency `GBP` — instead of carrying the
// original Mexican-launch naming forward as "historical residue." Env var
// names and behavior stay entity-agnostic either way, so a future entity swap
// is still a pure credential swap in the deploy environment, not a code change
// here.
//
// `currency` here is the settlement currency of the platform's OWN SaaS
// billing (SpiralClass Free/Pro subscriptions — see currencyForRegion's
// callers), which is a platform-wide charge and is the SAME for every teacher
// (single canonical currency — see D-99 for why multi-currency presentment
// was evaluated and deliberately not built). It is NOT what a teacher charges
// her own students — that's `pricing-currency.ts`'s `currencyForTeacher`, a
// teacher-chosen value (D-64).
//
// A live Stripe subscription/invoice's OWN `currency` field is the
// authoritative source for what a specific existing subscriber is actually
// billed in (see billing-webhook-handler.ts) — this registry only supplies
// the currency for a BRAND NEW checkout / a row with no live Stripe object
// yet. That split is what lets the canonical currency change here (as it just
// did, MXN → GBP) without silently reinterpreting any pre-existing MXN
// subscriber's stored rows: their `teacher_subscriptions.currency` /
// `subscription_invoices.currency` were captured at the time, per row, and
// never re-derived from this registry after the fact.
//
// This registry exists so that adding a second SIMULTANEOUSLY-ACTIVE regional
// entity later (a new key + its own env vars) is additive, instead of the
// implicit single-account assumption that caused the original UK→MX
// `transfers_not_allowed` issue and the now-removed `stripe_rail_force_disabled`
// workaround. Do NOT use this to add region-specific branching today — every
// teacher resolves to the same single client regardless of `platformRegion`.
export const PLATFORM_REGIONS = {
  GB: {
    // The settlement currency of this region's Stripe entity (ISO-4217). Every
    // NEW charge on the entity is denominated in it; it is NOT the teacher's
    // nationality/country, nor necessarily what a specific existing
    // subscriber's already-live Stripe subscription bills in (see file header).
    currency: "GBP",
    secretKeyEnv: "STRIPE_SECRET_KEY",
    webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    billingWebhookSecretEnv: "STRIPE_BILLING_WEBHOOK_SECRET",
  },
} as const;

export type PlatformRegion = keyof typeof PLATFORM_REGIONS;

export const DEFAULT_PLATFORM_REGION: PlatformRegion = "GB";

// THE canonical currency for the platform's own subscription pricing/billing —
// what a brand-new checkout charges in, and what every cross-currency
// analytics view (money-metrics.ts, the Financial Intelligence estimate layer)
// treats as "home". See the file header for why an existing subscriber's
// stored currency can still legitimately differ from this.
export const PLATFORM_MONEY_CURRENCY: string = PLATFORM_REGIONS[DEFAULT_PLATFORM_REGION].currency;

export function isPlatformRegion(value: string): value is PlatformRegion {
  return value in PLATFORM_REGIONS;
}

// The settlement currency of a platform region. Unknown / missing region falls
// back to the default region's currency (GBP today) — so a stray value can
// never silently mint an amount in a currency the platform can't settle.
export function currencyForRegion(region: string | null | undefined): string {
  if (region && isPlatformRegion(region)) return PLATFORM_REGIONS[region].currency;
  return PLATFORM_REGIONS[DEFAULT_PLATFORM_REGION].currency;
}
