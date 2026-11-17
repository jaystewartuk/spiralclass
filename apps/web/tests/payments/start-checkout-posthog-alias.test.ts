import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Checkout merges the browser's PostHog identity into the buyer's person
// (aliasServerUser), so the public funnel's anonymous page views and the
// purchase events keyed on student.id read as one person. The merge is
// permanent: PostHog cannot split a person afterwards.
//
// The browser is not always anonymous. A teacher booking for a student from
// her own device, or an admin testing a purchase, has a posthog-js cookie whose
// distinct_id is HER id, set by <PostHogIdentify>. Aliasing that would merge
// the student into the teacher for good (issue #89). So this suite runs the
// real cookie parser and the real analytics wrapper, with only posthog-node
// and the request's cookie jar faked, and checks what actually reaches
// PostHog's `alias` for each kind of cookie.

const PROJECT_TOKEN = "phc_checkout_test";
const COOKIE_NAME = `ph_${PROJECT_TOKEN}_posthog`;

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) as string } : undefined,
  }),
  headers: async () => new Headers(),
}));

const aliasMock = vi.fn();
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = vi.fn();
    identify = vi.fn();
    alias = aliasMock;
    shutdown = vi.fn(async () => {});
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudentTemplatePrice: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        package: { create: vi.fn(async () => ({ id: "pkg1" })) },
        payment: { create: vi.fn(async () => ({ id: "pay1", externalReference: "ext-ref-1" })) },
      }),
    ),
    payment: { update: vi.fn(async () => ({})) },
    teacherPayoutInstrument: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com", STRIPE_TAX_ENABLED: undefined }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    })),
    ensureCheckoutCustomer: vi.fn(async () => {
      throw new Error("no checkout Customer in this suite");
    }),
  }),
}));

vi.mock("@/lib/payments/reference", () => ({
  generatePaymentReference: (uuid: string) => `AGP-${uuid.slice(0, 4)}`,
}));
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueuePaymentPendingTeacher: vi.fn(async () => null),
}));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn(async () => {}) }));
vi.mock("@/lib/payments/supersede-pending", () => ({
  supersedePendingCheckouts: vi.fn(async () => {}),
}));
vi.mock("@/lib/marketing/events", () => ({ recordBookingStarted: vi.fn(async () => {}) }));
vi.mock("@/lib/analytics/attribution", () => ({
  currentAttribution: vi.fn(async () => null),
  attributionProperties: () => ({}),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retryAfterMs: 0 })),
  clientIp: vi.fn(async () => "1.2.3.4"),
}));

type StartCheckout = typeof import("@/lib/payments/start-checkout").startCheckout;

// The analytics wrapper is a hard no-op under NODE_ENV=test and caches its
// client per module instance, so each test imports a fresh graph with
// production-like env stubbed in.
async function freshStartCheckout(): Promise<StartCheckout> {
  vi.resetModules();
  return (await import("@/lib/payments/start-checkout")).startCheckout;
}

function setPostHogCookie(value: Record<string, unknown>) {
  cookieJar.set(COOKIE_NAME, encodeURIComponent(JSON.stringify(value)));
}

const student = { id: "student-1", email: "buyer@example.com", name: "Buyer" };

function args(): Parameters<StartCheckout>[0] {
  return {
    teacher: {
      id: "teacher-1",
      name: "Mira",
      bookingSlug: "mira",
      stripeAccountId: "acct_1",
      stripeChargesEnabled: true,
      country: "MX",
      pricingCurrency: "MXN",
    },
    student,
    template: {
      id: "tpl1",
      name: "10 clases",
      classCount: 10,
      classDurationMin: 50,
      priceMinorUnits: 150_000,
      transferPriceMinorUnits: 140_000,
      twoPersonPriceMinorUnits: null,
      twoPersonTransferPriceMinorUnits: null,
    },
    seats: 1,
    partnerConsent: false,
    paymentMethod: "stripe",
    source: "public",
    locale: "es",
  };
}

beforeEach(() => {
  cookieJar.clear();
  aliasMock.mockClear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("POSTHOG_KEY", PROJECT_TOKEN);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PROJECT_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startCheckout — merging the browser into the buyer in PostHog", () => {
  it("merges an anonymous visitor's browsing into the buyer", async () => {
    setPostHogCookie({ distinct_id: "0190-anon-browser", $user_state: "anonymous" });
    const startCheckout = await freshStartCheckout();

    const res = await startCheckout(args());

    expect(res).toMatchObject({ mode: "redirect" });
    expect(aliasMock).toHaveBeenCalledTimes(1);
    expect(aliasMock).toHaveBeenCalledWith({ distinctId: "student-1", alias: "0190-anon-browser" });
  });

  it("never merges the buyer into a teacher signed in on the same browser", async () => {
    // <PostHogIdentify> in the teacher app has run identify("teacher-1"), so
    // posthog-js's cookie now names her, not an anonymous visitor.
    setPostHogCookie({ distinct_id: "teacher-1", $user_state: "identified" });
    const startCheckout = await freshStartCheckout();

    const res = await startCheckout(args());

    expect(res).toMatchObject({ mode: "redirect" });
    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("never merges the buyer into an admin signed in on the same browser", async () => {
    setPostHogCookie({ distinct_id: "admin-actor-1", $user_state: "identified" });
    const startCheckout = await freshStartCheckout();

    await startCheckout(args());

    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("does not merge when the cookie does not say the visitor is anonymous", async () => {
    // A merge cannot be undone, so an identity of unknown state is refused
    // rather than guessed at. posthog-js writes $user_state on init.
    setPostHogCookie({ distinct_id: "someone" });
    const startCheckout = await freshStartCheckout();

    await startCheckout(args());

    expect(aliasMock).not.toHaveBeenCalled();
  });
});
