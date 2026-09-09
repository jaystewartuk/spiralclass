// Which Stripe payment capabilities to request on a teacher's merchant
// configuration, by her country (D-143).
//
// `card_payments` is universal and requested for everyone. This registry is the
// LOCAL methods on top of it — the ones a merchant in that country can offer
// and a merchant anywhere else cannot. They are the whole conversion argument
// for making the teacher merchant of record: a UK platform charge could not
// present OXXO to a Mexican student at any price, because offerable methods are
// decided by the MERCHANT's country.
//
// ── A capability name is a MEASUREMENT, never a guess ─────────────────────
//
// The v1 and v2 capability vocabularies are NOT the same, and v2 rejects an
// unknown name outright rather than ignoring it. Measured 2026-08-31 against
// `POST /v2/core/accounts` on `2026-06-24.dahlia`, with the exact payload
// `createConnectedAccount` sends:
//
//   pix_payments  → "Unknown field, did you mean fpx_payments, p24_payments,
//                    zip_payments?"          (no v2 equivalent exists at all)
//   fpx_payments  → "The fpx_payments capability requires `business_type` to
//                    be provided."           (we do not collect it at creation)
//
// Both were in this registry until 2026-08-31 and both were HARD FAILURES, not
// degradations: `accounts.create` 400s, so a Brazilian or Malaysian teacher
// could not create a connected account at all — she would have hit a generic
// error on the Stripe onboarding card with nothing to tell her why. Neither was
// caught by a unit test, because a mocked Stripe accepts any string.
//
// So: before adding a country, run `node scripts/probe-v2-capabilities.mjs`
// (test mode) and add only what it reports OK. `V2_REJECTED_CAPABILITIES` below
// records what has been measured as unusable, and a test fails if one of them
// reappears here.
//
// ── Why a registry rather than requesting everything ──────────────────────
//
// Over-requesting does not error, for names v2 does know. Measured on
// 2026-08-30: a GB account accepts `oxxo_payments` and `ideal_payments` and
// reports both as `restricted / requirements_past_due`, exactly like a
// capability that does apply. So Stripe will not tell you that you asked for
// something pointless.
//
// It is not free, though. Every requested capability can pull its own
// onboarding requirements, so requesting the union would make a teacher answer
// KYC questions for methods she will never offer — friction paid at the worst
// possible moment, on the screen where she is deciding whether to bother. Hence
// an explicit per-country list, added to as real teachers appear rather than
// speculatively.
//
// ── The capability is only HALF the gate ──────────────────────────────────
//
// An active capability does not make a method render. What Checkout offers is
// decided by the connected account's payment method configuration, which is a
// CHILD of the platform's parent configuration — and the parent is Dashboard-
// only (`GET /v1/payment_method_configurations/<parent>` answers "Platform
// parent configurations can only be managed via the dashboard"). Measured on
// production 2026-08-31: Alicia Moreno's account had `oxxo_payments: active` while
// her inherited config had `oxxo: {available: false, value: off}`, so her
// checkout rendered `payment_method_types: ["card"]` only. Turning OXXO and
// Bank Transfers on in Settings → Connect → Payment methods fixed it.
//
// A new local method therefore needs BOTH: the capability here, and the method
// switched on in that Dashboard parent configuration.
//
// ── What is deliberately NOT here ─────────────────────────────────────────
//
// Wallets (Apple Pay, Google Pay, Link) are absent because they are not
// separate capabilities — they ride on `card_payments` and surface through
// dynamic payment methods once the domain is registered.

/**
 * Local (non-card) capabilities to request for a merchant in `country`.
 * Returns an empty array for a country with no curated local methods, which is
 * the honest default: she gets cards, and her students get every wallet that
 * rides on them.
 */
export function localPaymentCapabilitiesFor(country: string): readonly string[] {
  return LOCAL_PAYMENT_CAPABILITIES[country.toUpperCase()] ?? EMPTY;
}

// `readonly` is a compile-time claim only: without this, every caller shares one
// live array and a stray `.push()` would poison the capability set for every
// subsequent teacher in that country for the life of the process. Frozen so the
// attempt fails loudly instead.
const EMPTY: readonly string[] = Object.freeze([]);
const freeze = (caps: string[]): readonly string[] => Object.freeze(caps);

const LOCAL_PAYMENT_CAPABILITIES: Record<string, readonly string[]> = {
  // Mexico — the first market this was built for, and the one that proves the
  // point. OXXO is a cash voucher paid at a convenience store, and SPEI
  // (`mx_bank_transfer_payments`) is the interbank transfer rail; between them
  // they reach students who have no card at all. Both confirm ASYNCHRONOUSLY
  // over hours, which the checkout flow handles: the session completes unpaid
  // and the later `payment_intent.succeeded` flips the row.
  //
  // Both require MXN presentment — Stripe hides a method whose currency the
  // session does not use — so they surface for a student paying in pesos and
  // quietly do not for one whom Adaptive Pricing has switched to another
  // currency. That is the correct behaviour, not a bug to work around.
  MX: freeze(["oxxo_payments", "mx_bank_transfer_payments"]),

  // Brazil — Boleto is the slow voucher, the same shape as OXXO.
  //
  // PIX IS ABSENT ON PURPOSE, and its absence costs real conversion: Pix is
  // instant and is the majority of Brazilian ecommerce, where Boleto is the
  // fallback. There is simply no way to ask for it on a v2 account — the field
  // does not exist (measured above), and the Dashboard's connected-account
  // payment methods page labels Pix "Only supported in v1 accounts". Do not
  // re-add it hoping; re-measure instead, and if Stripe ships it for v2 this is
  // the first entry to restore.
  BR: freeze(["boleto_payments"]),

  // The Netherlands and Poland: single dominant local rails, both effectively
  // required to sell at all.
  NL: freeze(["ideal_payments"]),
  PL: freeze(["blik_payments", "p24_payments"]),

  // Belgium and Austria.
  BE: freeze(["bancontact_payments"]),
  AT: freeze(["eps_payments"]),

  // Japan — konbini is the convenience-store voucher, the same shape as OXXO.
  JP: freeze(["konbini_payments", "jp_bank_transfer_payments"]),

  // Malaysia has NO entry, deliberately. `fpx_payments` is a real v2 capability
  // but refuses to be requested without `business_type`, which onboarding
  // collects later and creation does not have. A Malaysian teacher therefore
  // gets cards today. Adding FPX means sending `business_type` at creation,
  // which means asking her one more question before she has seen the product —
  // worth doing when a Malaysian teacher actually appears, not before.
};

// ── Bank transfer needs more than a capability ────────────────────────────
//
// SPEI (Mexico) and its Japanese equivalent reach Checkout as the
// `customer_balance` payment method, and `customer_balance` is the one method
// here that cannot be left to dynamic payment methods alone. Measured
// 2026-08-31 against `POST /v1/checkout/sessions`, each error appearing only
// once the previous was fixed:
//
//   1. "A value is required for `payment_method_options[customer_balance]
//      [funding_type]`."
//   2. "When using `funding_type=bank_transfer`, the
//      `payment_method_options[customer_balance][bank_transfer][type]`
//      parameter is required."
//   3. "The payment method `customer_balance` requires `customer` or
//      `customer_account` to be set."
//
// Step 3 is the expensive one: `customer_creation: "always"` does NOT satisfy
// it — measured, not assumed — because the transfer funds a customer's cash
// balance and the balance must exist before the session does. So a session that
// offers bank transfer needs a real Customer on the TEACHER's account, created
// before the session.
//
// That is why this is a separate lookup from the capability registry rather
// than derived from it: `mx_bank_transfer_payments` being active tells you she
// MAY offer it, and this tells the checkout how to ask.

/**
 * The Stripe `payment_method_options[customer_balance][bank_transfer][type]`
 * for a merchant in `country`, or null when bank transfer is not offered there.
 *
 * Deliberately only the countries whose entry in `LOCAL_PAYMENT_CAPABILITIES`
 * requests a bank-transfer capability — the two must not drift, and a test
 * asserts they don't. Adding a country means adding both halves and measuring,
 * not just naming a plausible `<cc>_bank_transfer`.
 */
export function bankTransferTypeFor(country: string): string | null {
  return BANK_TRANSFER_TYPES[country.toUpperCase()] ?? null;
}

const BANK_TRANSFER_TYPES: Readonly<Record<string, string>> = {
  MX: "mx_bank_transfer", // SPEI
  JP: "jp_bank_transfer",
};

/**
 * Capability names measured as unusable on a v2 merchant configuration with the
 * payload `createConnectedAccount` sends, mapped to the error Stripe returned.
 *
 * These are not a style preference: each one 400s `POST /v2/core/accounts`, so
 * a country whose entry contains one cannot onboard at all. A test asserts none
 * of them is in the registry above.
 */
export const V2_REJECTED_CAPABILITIES: Readonly<Record<string, string>> = {
  pix_payments: "Unknown field — no v2 equivalent (Dashboard: 'Only supported in v1 accounts')",
  fpx_payments: "Requires `business_type`, which account creation does not collect",
};
