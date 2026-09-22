#!/usr/bin/env node
// Probe payment capabilities against `POST /v2/core/accounts` in TEST mode,
// with the exact payload apps/web/src/lib/stripe/client.ts sends.
//
// Why this exists: v2 has a different capability vocabulary from v1 and rejects
// an unknown name with a 400, so a wrong entry in
// packages/shared/src/stripe-capabilities.ts is not a missing payment method —
// it is a teacher in that country who cannot create an account at all. A mocked
// Stripe accepts any string, so this is the only way to know.
//
//   STRIPE_TEST_SECRET_KEY=sk_test_... node scripts/probe-v2-capabilities.mjs
//   ... node scripts/probe-v2-capabilities.mjs BR:brl:pix_payments,boleto_payments
//
// With no arguments it re-measures the current registry. Test mode only: it
// refuses a live key, because it creates throwaway accounts.

const API = "https://api.stripe.com/v2/core/accounts";
const VERSION = "2026-06-24.dahlia";

const key = process.env.STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET_KEY) to a sk_test_ key.");
  process.exit(2);
}
if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
  console.error("Refusing to run: this creates accounts, so it needs a TEST key.");
  process.exit(2);
}

// country : default currency : comma-separated capabilities. Mirrors
// LOCAL_PAYMENT_CAPABILITIES plus the two names measured as unusable, so a
// bare run reproduces the 2026-08-31 result rather than only confirming today.
const DEFAULT_CASES = [
  "MX:mxn:oxxo_payments,mx_bank_transfer_payments",
  "BR:brl:boleto_payments",
  "BR:brl:pix_payments,boleto_payments",
  "NL:eur:ideal_payments",
  "PL:pln:blik_payments,p24_payments",
  "BE:eur:bancontact_payments",
  "AT:eur:eps_payments",
  "JP:jpy:konbini_payments,jp_bank_transfer_payments",
  "MY:myr:fpx_payments",
];

const cases = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CASES;

async function probe(spec) {
  const [country, currency, capsRaw = ""] = spec.split(":");
  const caps = capsRaw ? capsRaw.split(",").filter(Boolean) : [];

  const capabilities = { card_payments: { requested: true } };
  for (const c of caps) capabilities[c] = { requested: true };

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Stripe-Version": VERSION,
    },
    body: JSON.stringify({
      contact_email: `zz-probe-${country.toLowerCase()}@example.com`,
      dashboard: "full",
      identity: { country: country.toLowerCase() },
      configuration: { merchant: { capabilities }, customer: {} },
      defaults: {
        currency: currency.toLowerCase(),
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  const label = `${country} [${caps.join(" ") || "card only"}]`;
  if (res.ok && body.id) return { ok: true, line: `OK      ${label}  ${body.id}` };
  return { ok: false, line: `REJECT  ${label}\n        ${body?.error?.message ?? res.status}` };
}

let rejected = 0;
for (const spec of cases) {
  const { ok, line } = await probe(spec);
  if (!ok) rejected += 1;
  console.log(line);
}

console.log(
  `\n${cases.length - rejected} accepted, ${rejected} rejected. ` +
    "A rejection means that country cannot onboard — fix the registry, not the caller.",
);
