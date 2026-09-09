// SpiralClass — teacher pricing-currency registry (D-64).
//
// A teacher picks ONE currency for their whole business, captured once at
// onboarding and never changed afterward — the same capture-once posture as
// `Teacher.country` (see countries.ts). This is a genuinely different
// concept from `platform-regions.ts`'s `currencyForRegion` (the settlement
// currency of the platform's own Stripe *entity* — GBP since D-99, for
// everyone, because there is exactly one entity): pricing currency is what
// the TEACHER chooses to sell in, independent of which entity settles it.
//
// The curated list USED TO BE split by payout rail. It is not any more (D-143):
// both rails now offer the same list, because the mechanic that justified the
// split is gone.
//   * Card-rail teachers: the charge used to flow through the platform's own
//     GBP balance and out via Transfer, so the offer was narrowed to GBP/USD/EUR
//     — Stripe-native, 2-decimal, and cheap for a UK entity to settle. Under
//     direct charges the charge settles on HER connected account in HER country,
//     so a Mexican teacher settles in MXN and a Japanese one in JPY. Narrowing
//     her to GBP/USD/EUR would now be actively wrong: it would price her
//     business in a currency her own Stripe account does not settle in.
//   * Manual-rail teachers (everyone else): students pay the teacher's own
//     Wise account or bank account directly. This path NEVER creates a Stripe
//     Checkout Session (confirmed in start-checkout.ts — only
//     `paymentMethod === "stripe"` does), so Stripe's presentment-currency
//     support is irrelevant to this list.
//
// Sizing history: D-64 cut the manual-rail list to six LatAm currencies, a
// deliberate bet on the stated growth market when the rail was Wise-only.
// D-124 widened it, because the constraint that justified the narrow cut is
// gone: a teacher can now publish a bank account in her own country, and
// pinning her to six Latin American currencies would have made the rail
// reachable without being usable — a Nigerian teacher with a working NUBAN
// account, unable to price in naira. The list is now every currency a bank
// scheme pins, plus the majors, plus the currencies of markets where private
// language teaching is a real trade. Widen additively as real signups show up; NEVER
// narrow, because a teacher already priced in a removed currency would have
// no valid value to migrate to.

export const CONNECT_CIRCLE_PRICING_CURRENCIES = ["GBP", "USD", "EUR"] as const;
export type ConnectCirclePricingCurrency = (typeof CONNECT_CIRCLE_PRICING_CURRENCIES)[number];

export const MANUAL_RAIL_PRICING_CURRENCIES = [
  // Latin America — the launch market and the original D-64 cut.
  "MXN",
  "COP",
  "ARS",
  "CLP",
  "PEN",
  "BRL",
  "UYU",
  "DOP",
  "CRC",
  "GTQ",
  "BOB",
  "PYG",
  // The majors. A teacher outside the Connect circle very often prices in USD
  // regardless of where she banks — leaving them out was the single biggest
  // practical gap in the old list.
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "JPY",
  // Africa.
  "NGN",
  "ZAR",
  "KES",
  "GHS",
  "EGP",
  "MAD",
  "TZS",
  "UGX",
  "XOF",
  "XAF",
  // Asia.
  "INR",
  "PHP",
  "IDR",
  "VND",
  "THB",
  "MYR",
  "SGD",
  "HKD",
  "PKR",
  "BDT",
  "LKR",
  "NPR",
  "KRW",
  "CNY",
  "TWD",
  // Europe outside the euro, and the Middle East.
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "BGN",
  "SEK",
  "NOK",
  "DKK",
  "UAH",
  "TRY",
  "RSD",
  "AED",
  "SAR",
  "QAR",
  "ILS",
  "JOD",
] as const;
export type ManualRailPricingCurrency = (typeof MANUAL_RAIL_PRICING_CURRENCIES)[number];

// The full curated list, both rails combined — the shape `Teacher.pricingCurrency`
// is validated against regardless of which rail a given teacher is on (the
// per-rail split only matters for which subset the onboarding/settings picker
// offers — see `pricingCurrenciesForCountry`).
// Deduplicated: the majors appear on both rails, and a duplicate would show
// twice in any picker built straight off this list.
export const PRICING_CURRENCIES = [
  ...new Set<string>([...CONNECT_CIRCLE_PRICING_CURRENCIES, ...MANUAL_RAIL_PRICING_CURRENCIES]),
] as readonly (ConnectCirclePricingCurrency | ManualRailPricingCurrency)[];
export type PricingCurrency = ConnectCirclePricingCurrency | ManualRailPricingCurrency;

// The last-resort pricing currency: the `teachers.pricing_currency` column
// default, and the value used when a country maps to no confident preselect.
// In practice a teacher almost never lands on it — `pricingCurrenciesForCountry`
// narrows the picker by her rail and `COUNTRY_DEFAULT_CURRENCY` preselects her
// own country's currency — so this is the floor under that resolution, not a
// statement that teachers price in pesos.
export const DEFAULT_PRICING_CURRENCY: PricingCurrency = "MXN";

/**
 * True when `value` is in the curated pricing-currency list. This is the
 * app-level gate `Teacher.pricingCurrency` is validated against — deliberately
 * NOT a DB CHECK enumeration (see the `country`/`SUPPORTED_CONNECT_COUNTRIES`
 * precedent in countries.ts): widening the curated list is then a
 * shared-package change, not a migration. The DB still carries a lightweight
 * format CHECK (three uppercase letters) as defense in depth.
 */
export function isPricingCurrencySupported(value: string): value is PricingCurrency {
  return (PRICING_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

/**
 * The curated currency list to offer a teacher at onboarding/settings.
 *
 * Rail-independent since D-143 — every teacher is offered the full curated
 * list. The `country` parameter is retained because `COUNTRY_DEFAULT_CURRENCY`
 * still preselects her own country's currency, and because a future
 * per-country restriction would land here rather than at the call sites.
 */
export function pricingCurrenciesForCountry(_country: string): readonly string[] {
  return PRICING_CURRENCIES;
}

// Best-effort "this country's own currency" map, used only to PRESELECT the
// onboarding/settings currency picker — the teacher can always override it
// with any other currency from their rail's curated list. A country with no
// entry here simply gets no confident preselect and falls back to the rail's
// first curated currency instead. Widen this map ONLY in lockstep with the
// curated lists above — never map to a currency outside them.
const COUNTRY_DEFAULT_CURRENCY: Record<string, PricingCurrency> = {
  // Connect-circle
  GB: "GBP",
  US: "USD",
  // Eurozone members of the Connect circle (NOT every EEA country uses EUR —
  // e.g. SE/DK/NO/PL/CZ/HU/RO/BG/IS/LI don't, and have no entry here).
  AT: "EUR",
  BE: "EUR",
  CY: "EUR",
  DE: "EUR",
  EE: "EUR",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GR: "EUR",
  HR: "EUR",
  IE: "EUR",
  IT: "EUR",
  LT: "EUR",
  LU: "EUR",
  LV: "EUR",
  MT: "EUR",
  NL: "EUR",
  PT: "EUR",
  SI: "EUR",
  SK: "EUR",
  // Manual rail — Latin America
  MX: "MXN",
  CO: "COP",
  AR: "ARS",
  CL: "CLP",
  PE: "PEN",
  BR: "BRL",
  UY: "UYU",
  DO: "DOP",
  CR: "CRC",
  GT: "GTQ",
  BO: "BOB",
  PY: "PYG",
  // Manual rail — Africa
  NG: "NGN",
  ZA: "ZAR",
  KE: "KES",
  GH: "GHS",
  EG: "EGP",
  MA: "MAD",
  TZ: "TZS",
  UG: "UGX",
  // Manual rail — Asia
  IN: "INR",
  PH: "PHP",
  ID: "IDR",
  VN: "VND",
  TH: "THB",
  MY: "MYR",
  SG: "SGD",
  HK: "HKD",
  PK: "PKR",
  BD: "BDT",
  LK: "LKR",
  NP: "NPR",
  KR: "KRW",
  CN: "CNY",
  TW: "TWD",
  JP: "JPY",
  // Manual rail — Europe outside the euro, and the Middle East. Note the
  // absence of SE/NO/DK/PL/CZ/HU/RO/BG: they are EEA, hence inside the Connect
  // circle, so their teachers price from the Connect list and a preselect here
  // would name a currency their own picker never offers.
  UA: "UAH",
  TR: "TRY",
  RS: "RSD",
  AE: "AED",
  SA: "SAR",
  QA: "QAR",
  IL: "ILS",
  JO: "JOD",
  // Manual rail — the rest of the anglophone majors, for a teacher banking
  // there but outside the Connect circle for another reason.
  AU: "AUD",
  NZ: "NZD",
};

/**
 * The country's own currency, if it's one of the curated ones — null when
 * there's no confident match (see `COUNTRY_DEFAULT_CURRENCY` above). Callers
 * fall back to `pricingCurrenciesForCountry(country)[0]` when this is null.
 */
export function defaultPricingCurrencyForCountry(country: string): PricingCurrency | null {
  return COUNTRY_DEFAULT_CURRENCY[country.toUpperCase()] ?? null;
}

/**
 * THE single source of truth for "what currency is this teacher's class
 * pricing denominated in" — `teacher.pricingCurrency`, chosen once at
 * onboarding. Every money-row write for a teacher's own packages/prices
 * (checkout, package templates, custom prices, discounts, referral rewards)
 * derives its currency from here instead of hardcoding "MXN". Falls back to
 * the default only for a teacher with no value set — shouldn't happen
 * post-migration, but never throws.
 */
export function currencyForTeacher(teacher: { pricingCurrency?: string | null }): string {
  return teacher.pricingCurrency ?? DEFAULT_PRICING_CURRENCY;
}

/**
 * Stripe's minimum settleable charge, per presentment currency, in that
 * currency's minor units. Stripe rejects a Checkout Session below this, so the
 * checkout core validates against it BEFORE creating any rows.
 *
 * This MUST be keyed by the teacher's actual pricing currency, not a single MXN
 * constant: a Connect-circle teacher (D-64) prices in GBP/USD/EUR, where a
 * normal single-class price (e.g. £8) sits far above Stripe's real minimum but
 * below the old 1000-minor-unit MXN gate — which was blocking those sales
 * outright. Values are Stripe's published per-currency minimums (~US$0.50
 * equivalent; MXN is 10.00). Unknown currencies fall back to 1000 minor units,
 * a conservative gate that never permits a sub-minimum charge for the
 * currencies actually reachable here (GBP/USD/EUR/MXN).
 */
const STRIPE_MIN_CHARGE_MINOR_UNITS: Record<string, number> = {
  MXN: 1000, // 10.00 MXN
  USD: 50, // $0.50
  EUR: 50, // €0.50
  GBP: 30, // £0.30
};

export function stripeMinChargeMinorUnits(currency: string): number {
  return STRIPE_MIN_CHARGE_MINOR_UNITS[currency.toUpperCase()] ?? 1000;
}
