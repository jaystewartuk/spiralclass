import { beforeEach, describe, expect, it, vi } from "vitest";

// startCheckout is the shared core behind both purchase entry points (public
// funnel + in-portal repurchase). It is the money front door, so the tests
// pin: the rail-readiness gate, the grandfathered custom-price override, the
// Stripe vs. manual-transfer branch (redirect target + session args), the
// no-email refusal on the card rail, the teacher heads-up on the transfer
// rail, and — since D-113 — that the chosen payout instrument is resolved and
// written onto the Payment row.

// --- module seams -----------------------------------------------------------

const state = {
  // Grandfathering, per template id. Empty = no agreed price.
  agreedPrices: {} as Record<string, number>,
  paymentId: "pay1",
  externalReference: "ext-ref-1",
  packageId: "pkg1",
  // The instrument `resolveOfferableInstrument` will hand back, or null to
  // simulate one that was disabled between page render and submit.
  instrument: {
    id: "inst-wise-1",
    kind: "wise",
    enabled: true,
    accountHolder: "Mira",
    wiseHandle: "mira",
    wiseEmail: null,
    schemeId: null,
    details: null,
  } as Record<string, unknown> | null,
  rateLimitOk: true,
  // Drives stripeTaxEnabled() through the env mock below, so both arms of the
  // D-144 billing-address rule can be exercised.
  stripeTaxEnabled: undefined as string | undefined,
  // When set, the Stripe mocks throw with this message — standing in for a
  // revoked key, a dead connected account or an outage.
  stripeThrows: null as string | null,
  sessionUrl: "https://checkout.stripe.com/c/pay/cs_test_1" as string | null,
  paymentIntentClientSecret: "pi_test_1_secret_abc" as string | null,
  created: {} as { pkg?: unknown; payment?: unknown; sessionUpdate?: unknown },
};

const createCheckoutSession = vi.fn(async (_args: Record<string, unknown>) => {
  if (state.stripeThrows) throw new Error(state.stripeThrows);
  return { id: "cs_test_1", url: state.sessionUrl };
});

const createPaymentIntent = vi.fn(async (_args: Record<string, unknown>) => {
  if (state.stripeThrows) throw new Error(state.stripeThrows);
  return {
    id: "pi_test_1",
    status: "requires_payment_method" as const,
    amount: 150_000,
    currency: "mxn",
    client_secret: state.paymentIntentClientSecret,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudentTemplatePrice: {
      findMany: vi.fn(async () =>
        Object.entries(state.agreedPrices).map(([templateId, priceMinorUnits]) => ({
          templateId,
          priceMinorUnits,
        })),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        package: {
          create: vi.fn(async ({ data }: { data: unknown }) => {
            state.created.pkg = data;
            return { id: state.packageId };
          }),
        },
        payment: {
          create: vi.fn(async ({ data }: { data: unknown }) => {
            state.created.payment = data;
            return { id: state.paymentId, externalReference: state.externalReference };
          }),
        },
      };
      return fn(tx);
    }),
    payment: {
      update: vi.fn(async ({ data }: { data: unknown }) => {
        state.created.sessionUpdate = data;
        return {};
      }),
    },
    teacherPayoutInstrument: {
      findFirst: vi.fn(async () => state.instrument),
      findMany: vi.fn(async () => (state.instrument ? [state.instrument] : [])),
    },
  },
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    APP_URL: "https://spiralclass.com",
    STRIPE_TAX_ENABLED: state.stripeTaxEnabled,
  }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({ createCheckoutSession, createPaymentIntent }),
}));

vi.mock("@/lib/payments/reference", () => ({
  generatePaymentReference: (uuid: string) => `AGP-${uuid.slice(0, 4)}`,
}));

const enqueuePaymentPendingTeacher = vi.fn(async () => "notif1");
vi.mock("@/lib/notifications/enqueue", () => ({ enqueuePaymentPendingTeacher }));

const emitNotificationQueued = vi.fn(async () => {});
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued }));

const supersedePendingCheckouts = vi.fn(async () => {});
vi.mock("@/lib/payments/supersede-pending", () => ({ supersedePendingCheckouts }));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics: vi.fn() }));

// The checkout-create path is rate-limited (IP + per-buyer). Stub the limiter
// so the money-path assertions don't depend on next/headers being available in
// the test env; `state.rateLimitOk` lets one test exercise the throttled branch.
const rateLimit = vi.fn(async () => ({ ok: state.rateLimitOk, retryAfterMs: 0 }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit,
  clientIp: vi.fn(async () => "1.2.3.4"),
}));

const { startCheckout, railReadinessError } = await import("@/lib/payments/start-checkout");

// --- fixtures ---------------------------------------------------------------

function teacher(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "t1",
    name: "Mira",
    bookingSlug: "mira",
    stripeAccountId: "acct_1",
    stripeChargesEnabled: true,
    pricingCurrency: "MXN",
    ...over,
  } as Parameters<typeof startCheckout>[0]["teacher"];
}

function template(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tpl1",
    name: "10 clases",
    classCount: 10,
    classDurationMin: 50,
    priceMinorUnits: 150_000,
    transferPriceMinorUnits: 140_000,
    ...over,
  } as Parameters<typeof startCheckout>[0]["template"];
}

const student = { id: "s1", email: "mira@example.com", name: "Mira" };

// A ready Wise instrument, in the minimal shape the readiness gate takes.
const READY_WISE = {
  kind: "wise" as const,
  enabled: true,
  wiseHandle: "mira",
  schemeId: null,
  details: null,
};

function args(over: Partial<Parameters<typeof startCheckout>[0]> = {}) {
  return {
    teacher: teacher(),
    student,
    template: template(),
    paymentMethod: "stripe" as const,
    source: "public" as const,
    locale: "es-MX" as const,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.agreedPrices = {};
  state.instrument = {
    id: "inst-wise-1",
    kind: "wise",
    enabled: true,
    accountHolder: "Mira",
    wiseHandle: "mira",
    wiseEmail: null,
    schemeId: null,
    details: null,
  };
  state.rateLimitOk = true;
  state.stripeTaxEnabled = undefined;
  state.stripeThrows = null;
  state.sessionUrl = "https://checkout.stripe.com/c/pay/cs_test_1";
  state.paymentIntentClientSecret = "pi_test_1_secret_abc";
  state.created = {};
});

// --- railReadinessError -----------------------------------------------------

describe("railReadinessError", () => {
  it("blocks the card rail when the teacher can't take cards", () => {
    expect(
      railReadinessError(
        { stripeAccountId: null, stripeChargesEnabled: false, pricingCurrency: "MXN" },
        "stripe",
        "en",
        [READY_WISE],
      ),
    ).toMatch(/card payments/i);
  });

  it("allows the card rail when Stripe is connected and charges-enabled", () => {
    expect(
      railReadinessError(
        { stripeAccountId: "acct_1", stripeChargesEnabled: true, pricingCurrency: "MXN" },
        "stripe",
        "es-MX",
        [],
      ),
    ).toBeNull();
  });

  it("blocks the transfer rail when the teacher has no offerable instrument", () => {
    expect(railReadinessError(teacher(), "manual_transfer", "en", [])).toMatch(/transfer/i);
  });

  it("allows the transfer rail when an instrument is ready", () => {
    expect(railReadinessError(teacher(), "manual_transfer", "en", [READY_WISE])).toBeNull();
  });

  // The currency gate that used to live here tested a SPEI-only teacher
  // priced in GBP: a domestic clearing system settles its own currency alone,
  // so she could not in fact be paid and the gate had to say so. D-145 removed
  // that kind, and Wise settles any currency, so there is no longer a
  // ready-but-unpayable instrument to construct. Stripe covers the case the
  // test was protecting — her students see her country's own bank transfer.
});

// --- Stripe rail ------------------------------------------------------------

describe("startCheckout — Stripe rail", () => {
  it("creates a hosted session and redirects to its URL", async () => {
    const res = await startCheckout(args());
    expect(res).toEqual({
      mode: "redirect",
      redirectTo: "https://checkout.stripe.com/c/pay/cs_test_1",
      externalReference: "ext-ref-1",
    });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    const call = createCheckoutSession.mock.calls[0][0] as Record<string, unknown>;
    expect(call.clientReferenceId).toBe("ext-ref-1");
    expect(call.customerEmail).toBe("mira@example.com");
    // VAT/GST readiness is capture-only: tax computation is off by default (the
    // billing address is still collected via the client's default).
    expect(call.automaticTax).toBe(false);
    expect((call.lineItem as { amountMinorUnits: number }).amountMinorUnits).toBe(150_000);
    // success/cancel URLs are keyed by externalReference on the result page.
    expect(call.successUrl).toBe("https://spiralclass.com/b/mira/buy/result?ref=ext-ref-1");
  });

  it("persists the Stripe session id back onto the payment row", async () => {
    await startCheckout(args());
    expect(state.created.sessionUpdate).toEqual({ stripeCheckoutSessionId: "cs_test_1" });
  });

  it("refuses a card checkout for a student with no email on file", async () => {
    const res = await startCheckout(
      args({ student: { id: "s2", email: null, name: "Sin correo" } }),
    );
    expect(res).toHaveProperty("error");
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("errors when Stripe returns no payment link", async () => {
    state.sessionUrl = null;
    const res = await startCheckout(args());
    expect(res).toHaveProperty("error");
  });

  it("does not enqueue a teacher heads-up on the card rail", async () => {
    await startCheckout(args());
    expect(enqueuePaymentPendingTeacher).not.toHaveBeenCalled();
    expect(emitNotificationQueued).not.toHaveBeenCalled();
  });

  it("stamps the new Package and Payment rows with currency MXN", async () => {
    await startCheckout(args());
    expect((state.created.pkg as { currency: string }).currency).toBe("MXN");
    expect((state.created.payment as { currency: string }).currency).toBe("MXN");
  });

  // Regression: a total below Stripe's MXN minimum used to be passed straight
  // to createCheckoutSession, which throws AFTER the pending rows were written
  // — orphaning them and 500-ing the student. Reject before writing any rows.
  it("refuses a card total below the Stripe MXN minimum and writes no rows", async () => {
    const res = await startCheckout(args({ template: template({ priceMinorUnits: 500 }) }));
    expect(res).toHaveProperty("error");
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(state.created.pkg).toBeUndefined();
    expect(state.created.payment).toBeUndefined();
  });

  // Regression: the minimum-charge gate was a single MXN 1000 constant applied
  // to every currency, so a Connect teacher priced in GBP had a perfectly normal
  // sub-£10 class (e.g. £8) blocked outright — and told to "Choose Wise", a rail
  // Connect teachers don't have. The gate is now per-currency.
  it("does NOT block a GBP Connect teacher's £8 class, and charges in GBP", async () => {
    const res = await startCheckout(
      args({
        teacher: teacher({
          pricingCurrency: "GBP",
          payoutInstruments: [],
        }),
        template: template({ classCount: 1, priceMinorUnits: 800, transferPriceMinorUnits: null }),
      }),
    );
    expect(res).toHaveProperty("redirectTo");
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect((state.created.payment as { currency: string }).currency).toBe("GBP");
    const call = createCheckoutSession.mock.calls[0][0] as {
      lineItem: { currency: string; amountMinorUnits: number };
    };
    expect(call.lineItem.currency).toBe("gbp");
    expect(call.lineItem.amountMinorUnits).toBe(800);
  });

  it("refuses a zero total (fully-discounted) on the card rail without crashing", async () => {
    const res = await startCheckout(args({ template: template({ priceMinorUnits: 0 }) }));
    expect(res).toHaveProperty("error");
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(state.created.pkg).toBeUndefined();
  });
});

// --- D-144: the billing address follows the tax flag ------------------------
//
// The student rail used to send `billing_address_collection: "required"`
// unconditionally, banking an address for a tax computation that is switched
// off — five fields on the highest-abandonment screen in the product, charged
// to every student. These pin both arms so the coupling can't be
// silently undone, and so that turning tax ON is still all it takes to get a
// full address back.

describe("startCheckout — billing address (D-144)", () => {
  it("asks for no more address than the payment method needs while tax is off", async () => {
    state.stripeTaxEnabled = undefined;
    await startCheckout(args());

    const call = createCheckoutSession.mock.calls[0]![0]!;
    expect(call.billingAddressCollection).toBe("auto");
    expect(call.automaticTax).toBe(false);
  });

  it("requires the full address again the moment tax is switched on", async () => {
    state.stripeTaxEnabled = "1";
    await startCheckout(args());

    const call = createCheckoutSession.mock.calls[0]![0]!;
    expect(call.billingAddressCollection).toBe("required");
    expect(call.automaticTax).toBe(true);
  });
});

// --- Stripe being unreachable is an ERROR, not an exception -----------------
//
// A Stripe failure has nothing to do with the buyer: a revoked key, a
// connected account that no longer exists, an outage. Thrown, it escaped the
// server action and hit the error boundary, so the buyer lost the form, their
// typed details and their chosen class time, and got a full-page "Something
// went wrong" with nothing to retry. Observed on preview as a 403
// `account_invalid` taking down the whole checkout.

describe("startCheckout — when Stripe refuses", () => {
  it("returns an error the form can show, rather than throwing", async () => {
    state.stripeThrows = "Stripe API 403 on /v1/checkout/sessions: account_invalid";

    // The shared fixture is es-MX, so this also pins that the message is
    // localized rather than an English string leaking into a Spanish checkout.
    const es = await startCheckout(args());
    expect(es).toHaveProperty("error");
    expect((es as { error: string }).error).toMatch(/inténtalo de nuevo|transferencia/i);

    const en = await startCheckout(args({ locale: "en" }));
    expect((en as { error: string }).error).toMatch(/try again|bank transfer/i);
  });

  it("never shows the buyer Stripe's own message", async () => {
    // ...and never the raw text, which names the key and the account id and
    // tells a stranger the shape of our Stripe setup.
    state.stripeThrows =
      "The provided key 'sk_test_51abc' does not have access to account 'acct_seed_paulapagos'";

    const res = await startCheckout(args());

    const message = (res as { error: string }).error;
    expect(message).not.toContain("sk_test");
    expect(message).not.toContain("acct_");
  });
});

describe("startCheckout — Stripe rail, default ui mode", () => {
  it("defaults to hosted mode when stripeUiMode is omitted", async () => {
    await startCheckout(args());
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });
});

// --- manual-transfer rail ---------------------------------------------------

describe("startCheckout — manual-transfer rail", () => {
  const transferArgs = () =>
    args({ paymentMethod: "manual_transfer" as const, instrumentId: "inst-wise-1" });

  it("redirects to the transfer instructions page keyed by the reference", async () => {
    const res = await startCheckout(transferArgs());
    expect(res).toHaveProperty("redirectTo");
    expect((res as { redirectTo: string }).redirectTo).toMatch(/^\/b\/mira\/buy\/transfer\/AGP-/);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses the non-card price and emits the teacher heads-up after commit", async () => {
    await startCheckout(transferArgs());
    expect((state.created.payment as { amountMinorUnits: number }).amountMinorUnits).toBe(140_000);
    expect(enqueuePaymentPendingTeacher).toHaveBeenCalledTimes(1);
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif1",
      teacherId: "t1",
    });
  });

  // D-113: the instrument is what makes the rail generic. A manual payment
  // whose payee instructions can't be recovered is not reconcilable, and the
  // DB CHECK rejects it — so the row must carry the id.
  it("writes the chosen instrument onto the payment row", async () => {
    await startCheckout(transferArgs());
    expect((state.created.payment as { instrumentId?: string }).instrumentId).toBe("inst-wise-1");
  });

  it("refuses when no instrument was named, before creating any rows", async () => {
    const res = await startCheckout(args({ paymentMethod: "manual_transfer" as const }));
    expect(res).toHaveProperty("error");
    expect(state.created.pkg).toBeUndefined();
    expect(state.created.payment).toBeUndefined();
  });

  // The gap between the page render and the submit: the teacher disabled the
  // instrument in between. A clean error, not a CHECK-constraint violation
  // with an orphaned Package row behind it.
  it("refuses when the named instrument is no longer offerable", async () => {
    state.instrument = null;
    const res = await startCheckout(transferArgs());
    expect(res).toHaveProperty("error");
    expect(state.created.pkg).toBeUndefined();
    expect(state.created.payment).toBeUndefined();
  });
});

// --- rate limiting ----------------------------------------------------------

describe("startCheckout — rate limiting", () => {
  it("rate-limits the checkout-create entry by IP", async () => {
    await startCheckout(args());
    expect(rateLimit).toHaveBeenCalledWith(
      "1.2.3.4",
      expect.objectContaining({ scope: "checkout-create" }),
    );
  });

  it("refuses and creates nothing when throttled", async () => {
    state.rateLimitOk = false;
    const res = await startCheckout(args());
    expect(res).toHaveProperty("error");
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(supersedePendingCheckouts).not.toHaveBeenCalled();
  });
});

// --- pricing ----------------------------------------------------------------

describe("startCheckout — grandfathered pricing", () => {
  const charged = () =>
    (createCheckoutSession.mock.calls[0][0] as { lineItem: { amountMinorUnits: number } }).lineItem
      .amountMinorUnits;

  it("lets an agreed price for THIS package win over the catalog price", async () => {
    state.agreedPrices = { tpl1: 99_000 };
    await startCheckout(args());
    expect(charged()).toBe(99_000);
    expect((state.created.pkg as { pricePaidMinorUnits: number }).pricePaidMinorUnits).toBe(99_000);
  });

  // The bug the per-package table exists to kill: one flat number used to
  // apply to whichever package the student picked, so a student grandfathered
  // on the 4-class package could buy the 20-class one at that price.
  it("does NOT leak an agreed price onto a package it was not set for", async () => {
    state.agreedPrices = { "some-other-template": 99_000 };
    await startCheckout(args());
    expect(charged()).toBe(150_000);
  });

  it("always supersedes still-pending checkouts before creating new rows", async () => {
    await startCheckout(args());
    expect(supersedePendingCheckouts).toHaveBeenCalledWith(
      { teacherId: "t1", studentId: "s1", templateId: "tpl1" },
      expect.anything(),
    );
  });
});

// --- pay-at-reservation ------------------------------------------------------

describe("startCheckout — intended slot", () => {
  const start = new Date("2026-07-01T17:00:00.000Z");
  const stored = () => (state.created.pkg as { intendedStartUtc: Date | null }).intendedStartUtc;

  it("stores the chosen slot on the package for a single-class template", async () => {
    await startCheckout(
      args({
        template: template({ classCount: 1 }),
        intendedStartUtc: start,
      }),
    );
    expect(stored()).toEqual(start);
  });

  // D-111 reversed this: a multi-class package now carries the slot too, as
  // "pick your first class". It used to be hard-nulled here.
  it("stores the chosen slot on a multi-class package as its first class", async () => {
    await startCheckout(
      args({
        template: template({ classCount: 10 }),
        intendedStartUtc: start,
      }),
    );
    expect(stored()).toEqual(start);
  });

  it("leaves the slot null when none is chosen (single class)", async () => {
    await startCheckout(args({ template: template({ classCount: 1 }) }));
    expect(stored()).toBeNull();
  });

  // The picker is optional on a package, so this is the ordinary path, not an
  // edge case: no slot, no auto-book, the whole balance stays bookable.
  it("leaves the slot null when a package is bought without picking a time", async () => {
    await startCheckout(args({ template: template({ classCount: 10 }) }));
    expect(stored()).toBeNull();
  });
});
