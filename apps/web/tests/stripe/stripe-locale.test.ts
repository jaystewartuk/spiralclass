import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, type AppLocale } from "@spiralclass/shared";
import { fetchStripeClient } from "@/lib/stripe/client";
import {
  STRIPE_CHECKOUT_LOCALES,
  STRIPE_CONNECT_LOCALES,
  stripeCheckoutLocale,
  stripeConnectLocale,
} from "@/lib/stripe/locale";

// Stripe's own surfaces — Checkout, the receipt it emails, the embedded
// onboarding — were never told which language to speak, so each followed the
// browser. A student could read the booking page in the language her teacher
// chose for it and the payment form in another, switching at the moment she
// was asked to pay. These pin the request Stripe actually receives.

type Call = { url: string; method: string; body: URLSearchParams; idempotencyKey: string | null };

function makeFetch(responses: object[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: new URLSearchParams(String(init?.body ?? "")),
      idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
    });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch) {
  return fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
}

const SESSION = { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", mode: "payment" };
const TEACHER_ACCOUNT = "acct_teacher_mx";

const lessonCheckout = {
  connectedAccountId: TEACHER_ACCOUNT,
  clientReferenceId: "11111111-1111-4111-8111-111111111111",
  successUrl: "https://app.test/ok",
  cancelUrl: "https://app.test/no",
  customerEmail: "student@example.com",
  lineItem: { name: "4 classes", amountMinorUnits: 200_000, currency: "mxn" },
};

const billingCheckout = {
  customerAccountId: "acct_teacher",
  priceId: "price_monthly",
  clientReferenceId: "t1",
  successUrl: "https://a/s",
  cancelUrl: "https://a/c",
};

describe("the app-locale → Stripe-locale mapping", () => {
  it("gives every registered locale a value each Stripe surface accepts", () => {
    for (const { tag } of LOCALES) {
      expect(STRIPE_CHECKOUT_LOCALES, `Checkout locale for ${tag}`).toContain(
        stripeCheckoutLocale(tag),
      );
      expect(STRIPE_CONNECT_LOCALES, `Connect locale for ${tag}`).toContain(
        stripeConnectLocale(tag),
      );
    }
  });

  it("keeps each locale in its own language on both surfaces", () => {
    for (const { tag } of LOCALES) {
      const language = new Intl.Locale(tag).language;
      expect(new Intl.Locale(stripeCheckoutLocale(tag)).language, tag).toBe(language);
      expect(new Intl.Locale(stripeConnectLocale(tag)).language, tag).toBe(language);
    }
  });

  it("speaks Latin American Spanish, as the rest of the app formats it", () => {
    expect(stripeCheckoutLocale("es")).toBe("es-419");
    expect(stripeConnectLocale("es")).toBe("es-419");
  });

  it("answers DEFAULT_LOCALE's for a value the types say cannot arrive, rather than throwing", () => {
    // It runs after the pending Package and Payment rows are written. A throw
    // over a language tag would strand them and cost the buyer the checkout.
    const stray = "xx" as unknown as AppLocale;
    expect(stripeCheckoutLocale(stray)).toBe(stripeCheckoutLocale(DEFAULT_LOCALE));
    expect(stripeConnectLocale(stray)).toBe(stripeConnectLocale(DEFAULT_LOCALE));
  });
});

describe("lesson checkout — language", () => {
  it("tells Checkout which language to render in", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).createCheckoutSession({ ...lessonCheckout, locale: "es-419" });

    expect(calls[0]!.url).toContain("/v1/checkout/sessions");
    expect(calls[0]!.body.get("locale")).toBe("es-419");
  });

  it("leaves the language to Stripe when the caller names none", async () => {
    // Not sending the key at all is Stripe's `auto`. Sending an empty one is a
    // 400, which would take the checkout down for a missing nicety.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).createCheckoutSession(lessonCheckout);

    expect(calls[0]!.body.has("locale")).toBe(false);
  });
});

describe("ensureCheckoutCustomer — receipt language", () => {
  it("creates the Customer with the language of the page she bought on", async () => {
    // Stripe picks the language of the receipt it emails from the Customer's
    // preferred_locales, ahead of the account default and the browser.
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [] }, { id: "cus_new" }]);
    await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "new@example.com",
      preferredLocale: "fr",
    });

    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body.get("preferred_locales[0]")).toBe("fr");
  });

  it("sends no preferred_locales when none is given", async () => {
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [] }, { id: "cus_new" }]);
    await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "new@example.com",
    });

    expect([...calls[1]!.body.keys()].some((k) => k.startsWith("preferred_locales"))).toBe(false);
  });

  it("never rewrites a Customer the teacher already has", async () => {
    // She is the merchant and the Customer is hers: a language she set for a
    // buyer in her own dashboard is not ours to overwrite on the next purchase.
    const { fetchImpl, calls } = makeFetch([{ object: "list", data: [{ id: "cus_existing" }] }]);
    const id = await client(fetchImpl).ensureCheckoutCustomer({
      connectedAccountId: TEACHER_ACCOUNT,
      email: "student@example.com",
      preferredLocale: "es-419",
    });

    expect(id).toBe("cus_existing");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });
});

describe("subscription checkout — language", () => {
  it("tells Checkout which language to render in", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    await client(fetchImpl).createBillingCheckoutSession({ ...billingCheckout, locale: "fr" });

    expect(calls[0]!.body.get("locale")).toBe("fr");
  });

  // The teacher's id is stable across every attempt she makes, so the key is
  // too, and Stripe refuses a replayed key whose body differs (Sentry
  // SPIRALCLASS-2K, when the differing parameter was the price). The locale is
  // a parameter like any other: a teacher who switches language and tries
  // again inside Stripe's ~24h window must get a new key, not a 400.
  it("gives a retry in another language its own idempotency key", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    const c = client(fetchImpl);
    await c.createBillingCheckoutSession({ ...billingCheckout, locale: "es-419" });
    await c.createBillingCheckoutSession({ ...billingCheckout, locale: "en" });

    expect(calls[0]!.idempotencyKey).toBeTruthy();
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
  });

  it("still dedupes a same-plan, same-language double submit", async () => {
    const { fetchImpl, calls } = makeFetch([SESSION]);
    const c = client(fetchImpl);
    await c.createBillingCheckoutSession({ ...billingCheckout, locale: "en" });
    await c.createBillingCheckoutSession({ ...billingCheckout, locale: "en" });

    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it("cannot collide with a key minted before a locale was ever sent", async () => {
    // The first deploy to send a locale must not replay yesterday's key with a
    // body that now carries one more parameter.
    const { fetchImpl, calls } = makeFetch([SESSION]);
    const c = client(fetchImpl);
    await c.createBillingCheckoutSession(billingCheckout);
    await c.createBillingCheckoutSession({ ...billingCheckout, locale: "en" });

    expect(calls[0]!.body.has("locale")).toBe(false);
    expect(calls[0]!.idempotencyKey).toBe("bcs-t1-price_monthly");
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
  });
});
