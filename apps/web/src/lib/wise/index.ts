// Wise-specific payment helpers.
//
// Only the parts that are genuinely about Wise live here. The payment
// reference moved to lib/payments/reference.ts and the readiness/pricing
// gates to lib/payments/instruments.ts when D-113 made the manual rail
// generic — Wise is one instrument now, not the rail.
//
// Wise's public API does not expose a "create payment link" endpoint as of
// the current Wise Platform spec (confirmed against docs.wise.com). Every
// piece of the flow that does NOT require API access — the prefilled
// Quick-Pay URL — is built here.
//
// Design decisions:
//   * The prefilled URL targets Wise's hosted "send to" page, which honors
//     the `?amount=` and `?currency=` query params for personal Quick-Pay
//     handles. If a teacher's handle stops working, the page still renders
//     with the bare handle and the student picks the amount manually.
//   * `buildWisePayUrl` accepts the payment's own currency (Teacher.pricingCurrency,
//     D-64) — always pass it explicitly; the "MXN" default only exists for the
//     shouldn't-happen case of an unset value.

import { minorUnitsToMajor, currencyExponent } from "@spiralclass/shared";

// The public personal Wisetag Quick-Pay surface, as ONE constant.
//
// `wise.com/pay/<handle>` — the shape without `/me/` — 404s as of 2026-05, and
// the settings form's hint told the teacher her students would open exactly
// that. Two places named the URL and only one of them was right, so the string
// lives here now and the form renders this rather than a second copy of it.
export const WISE_PAY_BASE_URL = "https://wise.com/pay/me/";

export type BuildWisePayUrlInput = {
  handle: string;
  amountMinorUnits: number;
  // ISO-4217 code — the payment's own currency (Teacher.pricingCurrency).
  // Optional only for the shouldn't-happen case of a caller with no value;
  // defaults to "MXN" rather than throwing.
  currency?: string;
  // Wise's hosted page does not accept a reference param, so callers must
  // surface the reference separately in the UI. We accept it here for
  // future-proofing — when Wise exposes a `?reference=` param we flip
  // this on without touching call sites.
  reference?: string;
};

export function buildWisePayUrl(input: BuildWisePayUrlInput): string {
  const currency = input.currency ?? "MXN";
  // Minor→major via the currency's exponent, and format to that many decimals
  // (JPY → "1500", MXN → "1500.00") rather than assuming 2.
  const amount = minorUnitsToMajor(input.amountMinorUnits, currency).toFixed(
    currencyExponent(currency),
  );
  const params = new URLSearchParams({ amount, currency });
  // No-op today — see the `reference` comment above. Including it as a
  // hint won't break anything; Wise ignores unknown params.
  if (input.reference) {
    params.set("reference", input.reference);
  }
  // The handle is URL-encoded but should be safe alphanumeric per the
  // CHECK constraint on `teacher_payout_instruments.wise_handle`.
  return `${WISE_PAY_BASE_URL}${encodeURIComponent(input.handle)}?${params.toString()}`;
}
