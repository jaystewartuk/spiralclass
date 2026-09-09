import { describe, expect, it } from "vitest";
import { fetchStripeClient } from "@/lib/stripe/client";

// D-143: connected accounts are created through the Accounts v2 API, and the
// exact shape of that request is what decides whether the teacher can take a
// card payment at all. Every field asserted here is load-bearing, and a silent
// change to any of them fails in a way that is expensive to diagnose later:
//
//   dashboard "full"      — anything else cannot act as merchant of record.
//   configuration.merchant — the direct-charges configuration. `recipient` is
//                            the separate-charges-and-transfers one; requesting
//                            it instead would put the platform back in the
//                            funds flow D-143 removed it from.
//   configuration.customer — lets the platform bill her subscription against
//                            this same object, so there is no Account-to-
//                            Customer mapping table.
//   fees_collector        — "stripe": SHE pays card processing, at her own
//                            country's rates.
//   losses_collector      — "stripe": a chargeback debits HER balance. This is
//                            the field that keeps the platform out of
//                            client-money territory.
//
// Verified against Stripe test mode on 2026-08-30 before being written here,
// including that this shape is accepted on the SDK's STABLE bundled API version
// rather than requiring the `.preview` one the v2 docs show.

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

function makeFetch(responses: object[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      headers,
    });
    const body = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const V2_CREATED = { id: "acct_v2new", object: "v2.core.account" };
const V1_SHAPE = {
  id: "acct_v2new",
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
};

function client(fetchImpl: typeof fetch) {
  return fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
}

async function create(fetchImpl: typeof fetch) {
  return client(fetchImpl).createConnectedAccount({
    email: "profe@example.com",
    country: "MX",
    currency: "MXN",
    businessName: "Alicia Moreno",
  });
}

describe("createConnectedAccount — Accounts v2", () => {
  it("POSTs to /v2/core/accounts, then reads the account back through v1", async () => {
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    const account = await create(fetchImpl);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v2/core/accounts");
    // The read is v1 on purpose: Stripe serves a v2 account in the v1 shape, so
    // every existing caller, the account.updated webhook and the
    // charges_enabled/payouts_enabled columns are untouched by the migration.
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.url).toContain("/v1/accounts/acct_v2new");
    expect(account.id).toBe("acct_v2new");
    expect(account.charges_enabled).toBe(false);
  });

  it("sends the merchant-of-record configuration and Stripe-owned responsibilities", async () => {
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await create(fetchImpl);

    const sent = JSON.parse(calls[0]!.body);
    expect(sent.dashboard).toBe("full");
    expect(sent.configuration.merchant.capabilities.card_payments.requested).toBe(true);
    expect(sent.configuration.customer).toEqual({});
    expect(sent.defaults.responsibilities).toEqual({
      fees_collector: "stripe",
      losses_collector: "stripe",
    });
  });

  it("never requests the `recipient` configuration", async () => {
    // `recipient` is the configuration for separate charges and transfers —
    // an account that RECEIVES funds rather than being merchant of record.
    // Requesting it would quietly reinstate the funds flow D-143 removed.
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await create(fetchImpl);

    const sent = JSON.parse(calls[0]!.body);
    expect(sent.configuration.recipient).toBeUndefined();
    expect(Object.keys(sent.configuration).sort()).toEqual(["customer", "merchant"]);
  });

  it("lower-cases country and currency, which the v2 API requires", async () => {
    // The teacher's row stores ISO-3166 / ISO-4217 upper case ("MX", "MXN").
    // v2 rejects those; v1 accepted them. A regression here reads as a generic
    // 400 with nothing pointing at the casing.
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await create(fetchImpl);

    const sent = JSON.parse(calls[0]!.body);
    expect(sent.identity.country).toBe("mx");
    expect(sent.defaults.currency).toBe("mxn");
  });

  it("requests her country's LOCAL payment capabilities, not just cards", async () => {
    // The conversion argument for D-143 dies quietly without this. A capability
    // that is never requested is never offered, and nothing about that failure
    // looks broken: the account onboards clean, checkout renders, and the
    // Mexican student is simply shown cards only.
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await create(fetchImpl);

    const caps = JSON.parse(calls[0]!.body).configuration.merchant.capabilities;
    expect(caps.card_payments.requested).toBe(true);
    expect(caps.oxxo_payments.requested).toBe(true);
    expect(caps.mx_bank_transfer_payments.requested).toBe(true);
  });

  it("does not request local capabilities from another country", async () => {
    // Over-requesting does not error — a GB account will happily accept
    // oxxo_payments — but each requested capability can pull its own KYC
    // requirements, so asking for the union would make her answer onboarding
    // questions for methods she will never offer.
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await client(fetchImpl).createConnectedAccount({
      email: "teacher@example.com",
      country: "GB",
      currency: "GBP",
    });

    const caps = JSON.parse(calls[0]!.body).configuration.merchant.capabilities;
    expect(caps.card_payments.requested).toBe(true);
    expect(caps.oxxo_payments).toBeUndefined();
    expect(caps.pix_payments).toBeUndefined();
  });

  it("carries the teacher's name and contact email onto the account", async () => {
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await create(fetchImpl);

    const sent = JSON.parse(calls[0]!.body);
    expect(sent.contact_email).toBe("profe@example.com");
    expect(sent.display_name).toBe("Alicia Moreno");
  });
});

describe("idempotency", () => {
  // Creating a connected account is a check-then-create against our own DB, so
  // concurrent callers can all read a null stripeAccountId and each mint one.
  // Measured on 2026-08-30: FOURTEEN live connected accounts for a single
  // teacher, in two bursts about a second apart — Connect.js re-invoking
  // fetchClientSecret is enough to do it.
  //
  // Every other money call in this client already passed a stable key; account
  // creation used a random UUID, which made Stripe treat each attempt as a new
  // request. With a stable key Stripe collapses them and every caller gets the
  // same account back.
  it("sends the caller's stable idempotency key", async () => {
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await client(fetchImpl).createConnectedAccount({
      email: "profe@example.com",
      country: "MX",
      currency: "MXN",
      idempotencyKey: "connect-account-teacher-1",
    });

    expect(calls[0]!.headers["idempotency-key"]).toBe("connect-account-teacher-1");
  });

  it("does not reuse that key for the follow-up read", async () => {
    // The read is a GET and must not be collapsed with the create.
    const { fetchImpl, calls } = makeFetch([V2_CREATED, V1_SHAPE]);
    await client(fetchImpl).createConnectedAccount({
      email: "profe@example.com",
      country: "MX",
      currency: "MXN",
      idempotencyKey: "connect-account-teacher-1",
    });

    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.headers["idempotency-key"]).toBeUndefined();
  });
});
