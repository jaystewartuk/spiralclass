import type { StripeAddress } from "./types";

// The billing fields we persist for VAT/GST readiness (global-launch item 7).
// `billingCountry` is the ISO-3166-1 alpha-2 code (the minimum tax needs);
// `billingAddressJson` is the full structured snapshot Stripe collected, so
// enabling Stripe Tax later never requires re-collecting an address.
export type CapturedBilling = {
  billingCountry: string | null;
  billingAddressJson: Record<string, string>;
};

// Normalize a Stripe address (from a Checkout Session's `customer_details` or a
// Customer) into the columns we persist. Returns null when there's nothing
// worth storing, so callers never overwrite a previously-captured value with an
// empty one. The country is kept only when it matches the DB's alpha-2 CHECK
// (`^[A-Z]{2}$`); a malformed country still keeps the rest of the address.
export function capturedBillingFromAddress(
  address: StripeAddress | null | undefined,
): CapturedBilling | null {
  if (!address) return null;
  const entries = Object.entries(address).filter(
    ([, v]) => typeof v === "string" && v.trim() !== "",
  ) as Array<[string, string]>;
  if (entries.length === 0) return null;
  const billingAddressJson = Object.fromEntries(entries) as Record<string, string>;
  const country = billingAddressJson.country;
  const billingCountry = country && /^[A-Z]{2}$/.test(country) ? country : null;
  return { billingCountry, billingAddressJson };
}
