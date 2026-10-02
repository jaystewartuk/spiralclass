import type Stripe from "stripe";
import { DEFAULT_LOCALE, type AppLocale } from "@spiralclass/shared";

// What language Stripe's own surfaces speak — Checkout, the receipt it emails,
// and the embedded onboarding a teacher completes inside our settings page.
//
// None of them was ever told. Stripe's documented default for each is the
// BROWSER's language, so a student could read the booking page in the language
// the teacher chose for her buyers (`booking_page_locale`) and the payment form
// in another, switching at the moment she was asked to pay; and a teacher who
// reads the app in Spanish on an English-language laptop got her identity
// verification in English. The funnel pins one language end to end precisely
// so that cannot happen — this carries that pin across the last boundary.
//
// It lives beside the Stripe client rather than on the locale registry row
// because the values are Stripe's vocabulary, not ours: each surface publishes
// its own list, the lists disagree with each other (Checkout takes `en` and
// `fr`; Connect embedded components want `en-US` and `fr-FR`), and both lists
// below are transcribed so the mapping is checked against them by the compiler.
// The SDK's own `Locale` type cannot do that: it ends in `| string`.

// https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-locale
export const STRIPE_CHECKOUT_LOCALES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "en-GB",
  "es",
  "es-419",
  "et",
  "fi",
  "fil",
  "fr",
  "fr-CA",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "ms",
  "mt",
  "nb",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
  "zh-HK",
  "zh-TW",
] as const satisfies readonly Stripe.Checkout.SessionCreateParams.Locale[];

export type StripeCheckoutLocale = (typeof STRIPE_CHECKOUT_LOCALES)[number];

// https://docs.stripe.com/connect/get-started-connect-embedded-components#localization
export const STRIPE_CONNECT_LOCALES = [
  "bg-BG",
  "zh-Hans",
  "zh-Hant-HK",
  "zh-Hant-TW",
  "hr-HR",
  "cs-CZ",
  "da-DK",
  "nl-NL",
  "en-AU",
  "en-IN",
  "en-IE",
  "en-NZ",
  "en-SG",
  "en-GB",
  "en-US",
  "et-EE",
  "fil-PH",
  "fi-FI",
  "fr-CA",
  "fr-FR",
  "de-DE",
  "el-GR",
  "hu-HU",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "lv-LV",
  "lt-LT",
  "ms-MY",
  "mt-MT",
  "nb-NO",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "sk-SK",
  "sl-SI",
  "es-AR",
  "es-BR",
  "es-419",
  "es-MX",
  "es-ES",
  "sv-SE",
  "th-TH",
  "tr-TR",
  "vi-VN",
] as const;

export type StripeConnectLocale = (typeof STRIPE_CONNECT_LOCALES)[number];

// Exhaustive on purpose: a language added to the registry is a compile error
// here until someone has chosen what Stripe speaks for it. Spanish is Latin
// American (`es-419`) on both surfaces, matching the registry's own `intl`.
const STRIPE_LOCALE: Record<
  AppLocale,
  { checkout: StripeCheckoutLocale; connect: StripeConnectLocale }
> = {
  es: { checkout: "es-419", connect: "es-419" },
  en: { checkout: "en", connect: "en-US" },
  fr: { checkout: "fr", connect: "fr-FR" },
};

// The types make a miss impossible, and these run on the money path, where
// "impossible" is not good enough: the checkout call sits after the pending
// Package and Payment rows are written, so a throw here would strand them and
// show the buyer an error page over a language tag. A value that somehow is
// not in the registry gets DEFAULT_LOCALE's, like every other unforced choice.
function stripeLocalesFor(locale: AppLocale) {
  return STRIPE_LOCALE[locale] ?? STRIPE_LOCALE[DEFAULT_LOCALE];
}

/** The `locale` to create a Checkout Session with, and the tag a Customer's
 * `preferred_locales` carries so the emailed receipt matches the page. */
export function stripeCheckoutLocale(locale: AppLocale): StripeCheckoutLocale {
  return stripeLocalesFor(locale).checkout;
}

/** The `locale` to initialise Connect embedded components with. */
export function stripeConnectLocale(locale: AppLocale): StripeConnectLocale {
  return stripeLocalesFor(locale).connect;
}
