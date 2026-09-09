// SpiralClass — teacher country registry.
//
// A teacher's country (ISO-3166-1 alpha-2) is captured at onboarding and drives
// Stripe Connect account creation. Stripe fixes a connected account's country at
// creation time and NEVER lets it change, so a wrong value here permanently
// mis-configures the teacher's payout account — it is a genuine one-way door.
// The same field is the seed for tax-residency logic, and it already drives
// which curated pricing currencies a teacher is offered
// (`pricingCurrenciesForCountry`, D-64/D-124) — that is per-country, not
// MXN-only.
//
// Two distinct sets live here:
//   * COUNTRY_CODES        — every country a teacher may say they live in. The
//                            onboarding picker offers all of them so we capture
//                            true ground truth even for markets we can't pay out
//                            to yet.
//   * SUPPORTED_CONNECT_COUNTRIES — the subset we can currently create a Stripe
//                            merchant account for. Since D-143 this is NOT the
//                            cross-border payout circle any more. Direct charges
//                            settle on the teacher's own connected account in her
//                            own country and Stripe pays her out locally, so no
//                            cross-border Transfer happens and the circle no
//                            longer binds. Mexico, Brazil, Japan, Singapore,
//                            Thailand, Australia and the rest are in as a result.

import type { LocaleCode } from "./api";
import { COUNTRY_NAMES } from "./country-names";

// The `teachers.country` column default, and — load-bearing — the SENTINEL
// both onboarding forms read as "she has not chosen yet": while the stored
// value still equals this, the timezone-derived guess (`countryFromTimezone`,
// below) is allowed to overwrite the field, and once it differs the teacher's
// own pick is never overridden. So this is a "not answered" marker that
// happens to be spelled MX, not a claim that teachers are Mexican — the real
// country a teacher ends up with comes from her device's timezone or her own
// selection. Changing the value means changing the column default and both
// sentinel comparisons together, and would strand every existing row whose
// country genuinely is MX by default rather than by choice.
export const DEFAULT_TEACHER_COUNTRY = "MX" as const;

// Stripe Connect's cross-border payout circle (docs.stripe.com/connect/cross-border-payouts,
// confirmed while preparing D-58): a platform in any of these countries can
// Transfer to a connected account in any other of these countries. EEA = the
// 27 EU states plus Iceland, Liechtenstein, Norway.
const EEA_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

// Countries where a UK platform can create a v2 `Account` carrying the
// `merchant` configuration — i.e. where a teacher can take card payments as
// merchant of record.
//
// MEASURED, not inferred. Every code below was probed against Stripe test mode
// on 2026-08-30 with the exact config the app creates (dashboard "full",
// merchant + customer configurations, fees_collector and losses_collector both
// "stripe"). Re-probe before editing; a country's availability is Stripe's to
// change and is not fully documented anywhere.
//
// Known refusals, deliberately absent:
//   IN — "card_payments capability is not supported for ... country (IN)"
//   ZA, NG, ID — "v2 Account creation with configuration.merchant is currently
//                 unavailable in <CC> for your platform"
//   IS — same refusal. NOTE this is a NARROWING: Iceland was payable under the
//        old cross-border circle and is not creatable as a merchant. Icelandic
//        teachers fall back to the manual rail like any other absent country.
//
// BG is present but must not be created with BGN ("no longer supported, use eur
// instead") — the currency is chosen separately, so that is a pricing-currency
// concern, not a membership one.
//
// A country missing from this list is not stranded: it falls back to the
// country-agnostic manual transfer rail (D-124). Unlike the pre-D-143 failure
// mode, a wrong entry here surfaces at ONBOARDING as a failed account creation
// rather than after money has been taken.
export const SUPPORTED_CONNECT_COUNTRIES = [
  "AE",
  "AT",
  "AU",
  "BE",
  "BG",
  "BR",
  "CA",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GI",
  "GR",
  "HK",
  "HR",
  "HU",
  "IE",
  "IT",
  "JP",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "MX",
  "MY",
  "NL",
  "NO",
  "NZ",
  "PL",
  "PT",
  "RO",
  "SE",
  "SG",
  "SI",
  "SK",
  "TH",
  "US",
] as const;
export type SupportedConnectCountry = (typeof SUPPORTED_CONNECT_COUNTRIES)[number];

/**
 * True when the platform can currently create a Stripe merchant account for
 * `country`, letting that teacher take card payments as merchant of record.
 * Everywhere else falls back to the country-agnostic manual transfer rail.
 */
export function isConnectCountrySupported(country: string): country is SupportedConnectCountry {
  return (SUPPORTED_CONNECT_COUNTRIES as readonly string[]).includes(country.toUpperCase());
}

/** ISO-3166-1 alpha-2 shape check (two uppercase letters). */
export function isIsoCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/u.test(value);
}

/**
 * Localized display name for a country code, e.g. countryLabel("MX", "es-MX")
 * → "México". Reads the STATIC COUNTRY_NAMES catalog first so web and mobile
 * render identical names on every device — React Native (Hermes) has no
 * reliable Intl.DisplayNames at runtime and would otherwise show raw codes.
 * Falls back to runtime Intl (then the code) only for a code outside the
 * catalog, which shouldn't happen for COUNTRY_CODES.
 */
export function countryLabel(code: string, locale: LocaleCode = "en"): string {
  const c = code.toUpperCase();
  const entry = COUNTRY_NAMES[c];
  if (entry) return locale === "es-MX" ? entry["es-MX"] : entry.en;
  try {
    // fallback: "none" makes `.of()` return undefined for a well-formed but
    // unassigned code instead of "Unknown Region", so the code fallback wins.
    const dn = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    return dn.of(c) ?? c;
  } catch {
    return c;
  }
}

/**
 * All countries as `{ code, label }`, localized and sorted by label in the
 * caller's locale. Drives the onboarding country picker on web and mobile.
 */
export function countryOptions(locale: LocaleCode = "en"): Array<{ code: string; label: string }> {
  const collator = new Intl.Collator(locale);
  return COUNTRY_CODES.map((code) => ({ code, label: countryLabel(code, locale) })).sort((a, b) =>
    collator.compare(a.label, b.label),
  );
}

/**
 * Case-insensitive filter over country options by label OR code, used by the
 * searchable pickers on both platforms. An empty query returns everything so a
 * freshly-opened picker shows the full list.
 */
export function filterCountryOptions(
  options: Array<{ code: string; label: string }>,
  query: string,
): Array<{ code: string; label: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (c) => c.label.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
  );
}

/**
 * Best-effort ISO alpha-2 country from an IANA timezone, for prefilling the
 * onboarding picker. The timezone is a far better *location* signal than the UI
 * language (an en-US browser in Mexico still reports America/Mexico_City), and
 * we already collect it in the same step. Covers the launch-relevant zones
 * (all of the Americas + Western Europe + common markets); anything unmapped
 * returns null so the caller can fall back to the locale region or the MX
 * default. Not exhaustive by design — a suggestion, always user-correctable.
 */
export function countryFromTimezone(timezone: string): string | null {
  return TIMEZONE_TO_COUNTRY[timezone] ?? null;
}

const TIMEZONE_TO_COUNTRY: Record<string, string> = {
  // Mexico
  "America/Mexico_City": "MX",
  "America/Tijuana": "MX",
  "America/Monterrey": "MX",
  "America/Chihuahua": "MX",
  "America/Hermosillo": "MX",
  "America/Cancun": "MX",
  "America/Merida": "MX",
  "America/Matamoros": "MX",
  "America/Mazatlan": "MX",
  "America/Ojinaga": "MX",
  "America/Bahia_Banderas": "MX",
  // United States
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Anchorage": "US",
  "America/Detroit": "US",
  "Pacific/Honolulu": "US",
  "America/Indiana/Indianapolis": "US",
  // Canada
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  // Central America & Caribbean
  "America/Guatemala": "GT",
  "America/El_Salvador": "SV",
  "America/Tegucigalpa": "HN",
  "America/Managua": "NI",
  "America/Costa_Rica": "CR",
  "America/Panama": "PA",
  "America/Belize": "BZ",
  "America/Havana": "CU",
  "America/Santo_Domingo": "DO",
  "America/Puerto_Rico": "PR",
  "America/Port-au-Prince": "HT",
  "America/Jamaica": "JM",
  // South America
  "America/Bogota": "CO",
  "America/Lima": "PE",
  "America/Caracas": "VE",
  "America/La_Paz": "BO",
  "America/Guayaquil": "EC",
  "America/Asuncion": "PY",
  "America/Montevideo": "UY",
  "America/Santiago": "CL",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Buenos_Aires": "AR",
  "America/Sao_Paulo": "BR",
  "America/Manaus": "BR",
  "America/Fortaleza": "BR",
  "America/Recife": "BR",
  "America/Bahia": "BR",
  // Western & Southern Europe
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "Europe/Lisbon": "PT",
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Zurich": "CH",
  "Europe/Vienna": "AT",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Athens": "GR",
  "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU",
  // Eastern Europe / Middle East
  "Europe/Moscow": "RU",
  "Europe/Kyiv": "UA",
  "Europe/Kiev": "UA",
  "Europe/Istanbul": "TR",
  "Asia/Jerusalem": "IL",
  "Asia/Dubai": "AE",
  "Asia/Riyadh": "SA",
  "Africa/Cairo": "EG",
  // Asia-Pacific
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD",
  "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID",
  "Asia/Manila": "PH",
  "Asia/Singapore": "SG",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Hong_Kong": "HK",
  "Asia/Shanghai": "CN",
  "Asia/Taipei": "TW",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Perth": "AU",
  "Pacific/Auckland": "NZ",
  // Africa
  "Africa/Lagos": "NG",
  "Africa/Nairobi": "KE",
  "Africa/Johannesburg": "ZA",
  "Africa/Casablanca": "MA",
  "Africa/Accra": "GH",
};

// Every officially-assigned ISO-3166-1 alpha-2 country code. Display names live
// in the static COUNTRY_NAMES catalog (country-names.ts). If this list changes,
// regenerate that catalog from ICU:
//   node --input-type=module -e 'const en=new Intl.DisplayNames(["en"],{type:"region",fallback:"none"});const es=new Intl.DisplayNames(["es-MX"],{type:"region",fallback:"none"});for (const c of CODES) console.log(c, en.of(c), es.of(c))'
export const COUNTRY_CODES = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;
