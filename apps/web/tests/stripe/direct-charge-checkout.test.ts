import { describe, expect, it } from "vitest";
import { fetchStripeClient } from "@/lib/stripe/client";

// D-143: a lesson checkout is a DIRECT charge on the teacher's connected
// account. The `Stripe-Account` header is what makes it one — without it the
// session is created on the PLATFORM account, which silently reinstates the
// platform as merchant of record. That failure does not throw and does not look
// wrong in the dashboard; it just moves the money and the liability back. Hence
// asserting the header itself rather than only the request body.

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
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const SESSION = { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", mode: "payment" };
const TEACHER_ACCOUNT = "acct_teacher_mx";

function client(fetchImpl: typeof fetch) {
  return fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
}

async function createSession(fetchImpl: typeof fetch) {
  return client(fetchImpl).createCheckoutSession({
    connectedAccountId: TEACHER_ACCOUNT,
    clientReferenceId: "11111111-1111-4111-8111-111111111111",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
    customerEmail: "student@example.com",
    lineItem: { name: "4 clases", amountMinorUnits: 200_000, currency: "mxn" },
  });
}

describe("lesson checkout — direct charge", () => {
  it("creates the session ON the teacher's account (Stripe-Account header)", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createSession(fetchImpl);

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/checkout/sessions");
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("does not pin payment_method_types, so local methods can surface", async () => {
    // This was `payment_method_types: ["card"]`. Pinning it to card is what
    // made OXXO, SPEI, Pix, iDEAL and BLIK unreachable — and those are only
    // offerable at all because the merchant is now the teacher, in her country.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createSession(fetchImpl);

    const body = new URLSearchParams(calls[0]!.body);
    expect([...body.keys()].some((k) => k.startsWith("payment_method_types"))).toBe(false);
  });

  it("enables Adaptive Pricing so the student sees her own currency", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createSession(fetchImpl);

    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("adaptive_pricing[enabled]")).toBe("true");
  });

  it("takes no cut: neither an application fee nor a transfer", async () => {
    // The regression this guards is subtle and expensive: an application fee
    // reintroduces the undocumented cross-border fee matrix that D-143 removed,
    // and would silently fail for exactly the markets the platform expanded into.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createSession(fetchImpl);

    const keys = [...new URLSearchParams(calls[0]!.body).keys()];
    expect(keys.some((k) => k.startsWith("payment_intent_data[application_fee_amount]"))).toBe(
      false,
    );
    expect(keys.some((k) => k.startsWith("payment_intent_data[transfer_data]"))).toBe(false);
    expect(keys.some((k) => k.startsWith("transfer_data"))).toBe(false);
  });

  it("reads the session back on the same account", async () => {
    // A platform-scoped retrieve 404s for a connected-account session, which in
    // the webhook path would look like a missing payment rather than a
    // misrouted read.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).getCheckoutSession("cs_1", TEACHER_ACCOUNT);

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("omits the header entirely when no account is given", async () => {
    // The platform's own subscription billing really is a platform charge, so
    // the scoping helper must be a no-op rather than defaulting to something.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).getCheckoutSession("cs_1");

    expect(calls[0]!.headers["stripe-account"]).toBeUndefined();
  });
});

describe("account-scoped reads and refunds", () => {
  // Every one of these 404s if the Stripe-Account header is missing, because
  // the object lives on HER account (D-143). A 404 in the webhook path reads as
  // "no such payment", which is a much harder bug to trace back to a missing
  // header than an outright failure would be.

  it("refunds AS the connected account", async () => {
    const { fetchImpl, calls } = makeFetch([{ id: "re_1", status: "succeeded" }]);
    await client(fetchImpl).createRefund({
      paymentIntentId: "pi_1",
      reason: "requested_by_customer",
      connectedAccountId: TEACHER_ACCOUNT,
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/refunds");
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("reads a PaymentIntent on the connected account", async () => {
    const { fetchImpl, calls } = makeFetch([
      { id: "pi_1", status: "succeeded", amount: 200_000, currency: "mxn" },
    ]);
    await client(fetchImpl).getPaymentIntent("pi_1", TEACHER_ACCOUNT);
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("reads a charge on the connected account", async () => {
    const { fetchImpl, calls } = makeFetch([{ id: "ch_1", refunded: false }]);
    await client(fetchImpl).getCharge("ch_1", TEACHER_ACCOUNT);
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("expires a session on the connected account", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).expireCheckoutSession("cs_1", TEACHER_ACCOUNT);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("reads the settled charge on the connected account, expanding the balance transaction", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        id: "pi_1",
        currency: "mxn",
        latest_charge: {
          id: "ch_1",
          currency: "mxn",
          balance_transaction: { id: "txn_1", net: 18_000, fee: 2_000, currency: "mxn" },
        },
      },
    ]);
    const settled = await client(fetchImpl).getSettledCharge("pi_1", TEACHER_ACCOUNT);

    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
    expect(calls[0]!.url).toContain("expand");
    // The teacher's own net, in her own currency — the platform never sees this
    // money, it just reports on it.
    expect(settled).toEqual({
      chargeId: "ch_1",
      netMinorUnits: 18_000,
      feeMinorUnits: 2_000,
      currency: "mxn",
    });
  });

  it("returns null when the charge has not settled yet", async () => {
    // latest_charge comes back as a bare id string until it settles. Guessing a
    // net here would be inventing money.
    const { fetchImpl } = makeFetch([{ id: "pi_1", currency: "mxn", latest_charge: "ch_1" }]);
    expect(await client(fetchImpl).getSettledCharge("pi_1", TEACHER_ACCOUNT)).toBeNull();
  });
});

describe("createCustomerAccount", () => {
  // A teacher whose country Stripe refuses as a MERCHANT (IN, ZA, NG, ID, IS)
  // still buys the software, so she gets an Account with the customer
  // configuration only. Verified against test mode for ZA — one of the actual
  // refusals — on 2026-08-30.
  it("creates a customer-configuration account with no merchant configuration", async () => {
    const { fetchImpl, calls } = makeFetch([
      { id: "acct_cust1", object: "v2.core.account", applied_configurations: ["customer"] },
    ]);
    const account = await client(fetchImpl).createCustomerAccount({
      email: "teacher@example.com",
      country: "ZA",
      businessName: "Thandi",
    });

    expect(account.id).toBe("acct_cust1");
    expect(calls[0]!.url).toContain("/v2/core/accounts");
    const sent = JSON.parse(calls[0]!.body);
    expect(Object.keys(sent.configuration)).toEqual(["customer"]);
    // Requesting `merchant` here is what Stripe refuses for these countries —
    // asking for it anyway would fail the whole call and block her subscription.
    expect(sent.configuration.merchant).toBeUndefined();
    expect(sent.identity.country).toBe("za");
    // No dashboard and no responsibilities: she is not a merchant, so there are
    // no fees or losses to assign.
    expect(sent.dashboard).toBeUndefined();
    expect(sent.defaults).toBeUndefined();
  });
});

// ── Bank transfer (SPEI) ──────────────────────────────────────────────────
//
// `customer_balance` is the one method dynamic payment methods cannot switch on
// alone. Measured against the live API on 2026-08-31, each error surfacing only
// once the previous was fixed: funding_type required → bank_transfer.type
// required → "requires `customer` or `customer_account` to be set". Notably
// `customer_creation: "always"` does NOT satisfy the last one, which is why
// this sends a real Customer id.
describe("lesson checkout — bank transfer (SPEI)", () => {
  const CUSTOMER = "cus_student_1";

  async function createWith(
    fetchImpl: typeof fetch,
    extra: { customerId?: string; merchantCountry?: string },
  ) {
    return client(fetchImpl).createCheckoutSession({
      connectedAccountId: TEACHER_ACCOUNT,
      clientReferenceId: "22222222-2222-4222-8222-222222222222",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      customerEmail: "student@example.com",
      lineItem: { name: "1 clase", amountMinorUnits: 38_000, currency: "mxn" },
      ...extra,
    });
  }

  it("asks for the Mexican bank-transfer variant when customer and country are known", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { customerId: CUSTOMER, merchantCountry: "MX" });

    const body = decodeURIComponent(calls[0]!.body);
    expect(body).toContain("payment_method_options[customer_balance][funding_type]=bank_transfer");
    expect(body).toContain(
      "payment_method_options[customer_balance][bank_transfer][type]=mx_bank_transfer",
    );
  });

  it("sends customer INSTEAD of customer_email — Stripe rejects both together", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { customerId: CUSTOMER, merchantCountry: "MX" });

    const body = decodeURIComponent(calls[0]!.body);
    expect(body).toContain(`customer=${CUSTOMER}`);
    expect(body).not.toContain("customer_email=");
  });

  it("falls back to customer_email when no Customer could be created", async () => {
    // ensureCheckoutCustomer fails soft: bank transfer is an EXTRA method and
    // must never cost the student a checkout they could complete on a card.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { merchantCountry: "MX" });

    const body = decodeURIComponent(calls[0]!.body);
    expect(body).toContain("customer_email=student@example.com");
    expect(body).not.toContain("payment_method_options[customer_balance]");
  });

  it("omits the option for a country with no known variant rather than guessing", async () => {
    // A wrong bank_transfer type is rejected outright, taking the whole
    // checkout with it — so an unknown country offers no bank transfer.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { customerId: CUSTOMER, merchantCountry: "GB" });

    const body = decodeURIComponent(calls[0]!.body);
    expect(body).toContain(`customer=${CUSTOMER}`);
    expect(body).not.toContain("payment_method_options[customer_balance]");
  });

  it("omits it when the country is unknown entirely", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { customerId: CUSTOMER });

    expect(decodeURIComponent(calls[0]!.body)).not.toContain(
      "payment_method_options[customer_balance]",
    );
  });

  it("still names no payment_method_types — everything else stays dynamic", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await createWith(fetchImpl, { customerId: CUSTOMER, merchantCountry: "MX" });

    expect(decodeURIComponent(calls[0]!.body)).not.toContain("payment_method_types");
  });
});

describe("ensureCheckoutCustomer", () => {
  it("reuses an existing Customer on HER account rather than creating another", async () => {
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [{ id: "cus_existing" }] }]);
    const id = await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "student@example.com",
    });

    // Stripe has no uniqueness constraint on customer email, so without the
    // lookup a returning student becomes one Customer per purchase in the
    // teacher's own dashboard.
    expect(id).toBe("cus_existing");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
  });

  it("creates one on HER account when the student is new", async () => {
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [] }, { id: "cus_new" }]);
    const id = await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "new@example.com",
      name: "New Student",
    });

    expect(id).toBe("cus_new");
    // The Customer must belong to the teacher, not the platform — she is the
    // merchant, and these are her buyers.
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers["stripe-account"]).toBe(TEACHER_ACCOUNT);
    const body = decodeURIComponent(calls[1]!.body);
    expect(body).toContain("email=new@example.com");
    expect(body).toContain("name=New Student");
  });

  it("omits name when the student has none", async () => {
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [] }, { id: "cus_new" }]);
    await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "anon@example.com",
    });

    expect(decodeURIComponent(calls[1]!.body)).not.toContain("name=");
  });
});
