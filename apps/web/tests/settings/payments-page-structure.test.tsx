import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime (React.createElement) under
// vitest's esbuild; the web suite otherwise never renders components, so make
// React available globally before the page module evaluates.
(globalThis as Record<string, unknown>).React = React;

// /settings/payments answers exactly one question — can my students pay me,
// and how — and until this change it answered it nowhere. These tests pin the
// answer rather than the styling: the readiness resolver's states, the words
// the status panel puts on each of them, and the two consequences the page has
// to state out loud (a teacher with no rail is unlisted; disconnecting stops
// card payments).

vi.mock("@/components/locale-provider", () => ({
  useT: () => createT("en"),
  useLocale: () => "en",
}));

const teacher: Record<string, unknown> = {};
let instruments: unknown[] = [];
let stripeConfigured = true;
let embeddedCheckout = false;

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => teacher }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "en",
  getT: async () => createT("en"),
}));
vi.mock("@/lib/env", () => ({
  hasStripeCreds: () => stripeConfigured,
  hasStripeEmbeddedCheckout: () => embeddedCheckout,
  clientEnv: () => ({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/payments/instruments", () => ({
  listTeacherInstruments: async () => instruments,
}));
vi.mock("@/app/actions/stripe-connect", () => ({
  startStripeConnect: async () => {},
  disconnectStripeConnect: async () => {},
}));
vi.mock("@/app/actions/payout-instruments", () => ({
  updateWiseInstrument: async () => undefined,
}));
// Connect.js reaches for the DOM on import; the fallback path is what these
// fixtures exercise anyway (no publishable key).
vi.mock("@/app/(app)/settings/payments/stripe-connect-embedded", () => ({
  StripeConnectEmbeddedOnboarding: () => null,
}));

const { resolvePayoutReadiness } = await import("@/app/(app)/settings/payments/payout-readiness");
const { PayoutStatusPanel } = await import("@/app/(app)/settings/payments/payout-status");
const { WiseForm } = await import("@/app/(app)/settings/payments/wise-form");
const { default: PaymentsPage } = await import("@/app/(app)/settings/payments/page");

const t = createT("en");

// `renderToStaticMarkup` escapes the characters React escapes, and the copy on
// this page is full of apostrophes ("can't pay you yet", "Stripe's fee"). Every
// assertion below compares against the catalog string as it actually lands in
// the markup rather than against a hand-typed entity.
const esc = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
/** The catalog string for `key`, escaped the way it renders. */
const c = (key: Parameters<typeof t>[0]) => esc(t(key));
const PAGE_SOURCE = readFileSync(
  resolve(__dirname, "../../src/app/(app)/settings/payments/page.tsx"),
  "utf8",
);

const BASE_TEACHER: Record<string, unknown> = {
  id: "t1",
  // GB is inside the measured Connect set (D-143), so the card rail is on
  // offer unless a test says otherwise.
  country: "GB",
  stripeAccountId: null,
  stripeChargesEnabled: false,
  stripePayoutsEnabled: false,
  stripeAccountLinkedAt: null,
  stripeRequirementsDisabledReason: null,
  pricingCurrency: "GBP",
};

const wiseInstrument = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  kind: "wise",
  enabled: true,
  accountHolder: null,
  wiseHandle: "anateacher",
  wiseEmail: null,
  ...over,
});

beforeEach(() => {
  for (const key of Object.keys(teacher)) delete teacher[key];
  Object.assign(teacher, BASE_TEACHER);
  instruments = [];
  stripeConfigured = true;
  embeddedCheckout = false;
});

async function pageHtml(): Promise<string> {
  return renderToStaticMarkup(await PaymentsPage({ searchParams: Promise.resolve({}) }));
}

describe("resolvePayoutReadiness", () => {
  const base = {
    stripeConfigured: true,
    payoutCountrySupported: true,
    stripeAccountId: null as string | null,
    stripeChargesEnabled: false,
    instruments: [] as { kind: "wise"; enabled: boolean; wiseHandle: string | null }[],
  };

  it("is blocked until a rail can actually take a payment", () => {
    expect(resolvePayoutReadiness(base)).toEqual({
      card: "not-connected",
      wise: "not-connected",
      canBePaid: false,
    });
  });

  it("counts a linked-but-unverified Stripe account as work, not as a rail", () => {
    // The distinction the old page buried in "Charges enabled: pending": an
    // account exists, and nobody can pay through it yet.
    const r = resolvePayoutReadiness({ ...base, stripeAccountId: "acct_1" });
    expect(r.card).toBe("verifying");
    expect(r.canBePaid).toBe(false);

    expect(
      resolvePayoutReadiness({ ...base, stripeAccountId: "acct_1", stripeChargesEnabled: true }),
    ).toMatchObject({ card: "live", canBePaid: true });
  });

  it("keeps a linked account live even outside the supported set", () => {
    // The country gate governs whether she may START, not whether the account
    // she already has works — telling her "not available in your country"
    // while her students are paying through it would simply be false.
    expect(
      resolvePayoutReadiness({
        ...base,
        payoutCountrySupported: false,
        stripeAccountId: "acct_1",
        stripeChargesEnabled: true,
      }),
    ).toMatchObject({ card: "live" });
  });

  it("separates 'not available in your country' from 'this deploy has no Stripe'", () => {
    expect(resolvePayoutReadiness({ ...base, payoutCountrySupported: false }).card).toBe(
      "unavailable",
    );
    expect(resolvePayoutReadiness({ ...base, stripeConfigured: false }).card).toBe("hidden");
  });

  it("distinguishes every Wise state a row can be in", () => {
    const wise = (over: Partial<{ enabled: boolean; wiseHandle: string | null }>) =>
      resolvePayoutReadiness({
        ...base,
        instruments: [{ kind: "wise", enabled: true, wiseHandle: "mira", ...over }],
      }).wise;

    expect(wise({})).toBe("live");
    // Enabled with nothing to pay to. The validator refuses to create this,
    // but a handle cleared through an older path lands here, and it must not
    // read as "off" — the row's whole job is to say what is missing.
    expect(wise({ wiseHandle: null })).toBe("incomplete");
    expect(wise({ enabled: false })).toBe("off");
    expect(wise({ enabled: false, wiseHandle: null })).toBe("not-connected");
  });
});

describe("PayoutStatusPanel", () => {
  const render = (readiness: Parameters<typeof PayoutStatusPanel>[0]["readiness"]) =>
    renderToStaticMarkup(<PayoutStatusPanel readiness={readiness} t={t} />);

  it("states the consequence of having no rail, not just the fact", () => {
    const html = render({ card: "not-connected", wise: "not-connected", canBePaid: false });
    expect(html).toContain(c("web.settings.payments.status.blockedHeadline"));
    // The sentence the page never said: no rail means her booking page is
    // unlisted (D-104's hasPayoutMethod signal), so nobody reaches a checkout.
    expect(html).toContain(c("web.settings.payments.status.blockedBody"));
    // One call to action, anchored at the section that fixes it.
    expect(html).toContain(c("web.settings.payments.status.setUpCta"));
    expect(html).toContain('href="#stripe"');
  });

  it("points the call to action at Wise when the card rail is not hers to fix", () => {
    const html = render({ card: "unavailable", wise: "not-connected", canBePaid: false });
    expect(html).toContain('href="#wise"');
    expect(html).not.toContain('href="#stripe"');
  });

  it("drops the call to action once she can be paid", () => {
    const html = render({ card: "live", wise: "off", canBePaid: true });
    expect(html).toContain(c("web.settings.payments.status.readyHeadline"));
    expect(html).not.toContain(c("web.settings.payments.status.setUpCta"));
  });

  it("carries every state as a WORD, never as colour alone", () => {
    const html = render({ card: "verifying", wise: "incomplete", canBePaid: false });
    expect(html).toContain(c("web.settings.payments.state.verifying"));
    expect(html).toContain(c("web.settings.payments.state.needsWisetag"));
  });

  it("omits a rail this deploy does not have rather than blaming her country", () => {
    const html = render({ card: "hidden", wise: "live", canBePaid: true });
    expect(html).not.toContain(c("web.settings.payments.method.card"));
    expect(html).not.toContain(c("web.settings.payments.state.unavailableHere"));
    expect(html).toContain(c("web.settings.payments.method.wise"));
  });

  it("pairs each rail with its state as a description list", () => {
    // Two spans lose the association a screen reader reads the pair by.
    const html = render({ card: "live", wise: "off", canBePaid: true });
    expect(html).toContain("<dl");
    expect(html).toContain("<dt");
    expect(html).toContain("<dd");
  });
});

describe("the payments page", () => {
  it("leads with the verdict, then the sections that change it", async () => {
    const html = await pageHtml();

    expect(html).toContain(c("web.settings.payments.status.blockedHeadline"));
    expect(html.indexOf(c("web.settings.payments.status.blockedHeadline"))).toBeLessThan(
      html.indexOf(c("web.settings.payments.method.wise")),
    );
    // Named groups with real landmarks, not a stack of peer cards.
    expect(html).toContain('<section id="stripe" aria-labelledby="stripe-heading"');
    expect(html).toContain('<section id="wise" aria-labelledby="wise-heading"');
    // Section titles descend from the page heading rather than matching it.
    expect(html).not.toContain("text-2xl");
  });

  it("reports a linked account's status as badges beside labelled facts", async () => {
    Object.assign(teacher, {
      stripeAccountId: "acct_1H2g3F4e5D6c7B8a",
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeAccountLinkedAt: new Date("2026-03-04T12:00:00Z"),
    });

    const html = await pageHtml();

    expect(html).toContain(c("web.settings.payments.accountStatusTitle"));
    expect(html).toContain("acct_1H2g3F4e5D6c7B8a");
    // An acct_ id is 21 unbroken characters against a 320px phone.
    expect(html).toContain("break-all");
    expect(html).toContain(c("web.settings.payments.value.pending"));
    expect(html).toContain(c("web.settings.payments.continueVerification"));
    // The date renders in her own resolved locale, not a hardcoded en-US/es-MX
    // pair — `fr` was formatted as en-US until this stopped branching.
    expect(html).toContain("Mar 4, 2026");
  });

  it("surfaces Stripe's own reason when an account is restricted", async () => {
    Object.assign(teacher, {
      stripeAccountId: "acct_1",
      stripeRequirementsDisabledReason: "requirements.past_due",
    });
    const html = await pageHtml();
    expect(html).toContain("requirements.past_due");
  });

  it("puts disconnecting behind a confirmation, never a bare submit", async () => {
    Object.assign(teacher, { stripeAccountId: "acct_1", stripeChargesEnabled: true });
    const html = await pageHtml();

    expect(html).toContain(c("web.settings.payments.disconnectRowTitle"));
    // The consequence is named, and the control that carries it is the dialog
    // component rather than a form posting straight to the server action.
    expect(PAGE_SOURCE).toContain("DisconnectStripeButton");
    expect(PAGE_SOURCE).not.toMatch(/<form action=\{disconnectStripeConnect\}/);
  });

  it("explains a country the platform cannot make a merchant account for", async () => {
    Object.assign(teacher, { country: "IN" });
    const html = await pageHtml();

    expect(html).toContain(c("web.settings.payments.state.unavailableHere"));
    expect(html).toContain(c("web.settings.payments.countryUnsupportedHelp"));
    // Nothing that looks like a control she could use.
    expect(html).not.toContain(c("web.settings.payments.connectStripe"));
  });

  it("says nothing about Stripe on a deploy that has none", async () => {
    stripeConfigured = false;
    const html = await pageHtml();

    expect(html).not.toContain(c("web.settings.payments.state.unavailableHere"));
    expect(html).not.toContain(c("web.settings.payments.connectStripe"));
    // ...and the fee disclosure goes with it: there is no second bill to warn
    // about where there is no card rail (D-152).
    expect(html).not.toContain(c("web.settings.payments.feesTitle"));
    expect(html).toContain(c("web.settings.payments.method.wise"));
  });

  it("keeps the D-152 fee disclosure wherever a card rail exists", async () => {
    const html = await pageHtml();
    expect(html).toContain(c("web.settings.payments.feesTitle"));
    expect(html).toContain(c("web.settings.payments.feesBody"));
  });

  it("says she can be paid once one rail is live", async () => {
    instruments = [wiseInstrument()];
    const html = await pageHtml();
    expect(html).toContain(c("web.settings.payments.status.readyHeadline"));
    expect(html).toContain(c("web.settings.payments.state.live"));
  });
});

describe("WiseForm", () => {
  const render = (props: Partial<React.ComponentProps<typeof WiseForm>> = {}) =>
    renderToStaticMarkup(
      <WiseForm enabled={false} handle={null} accountHolder={null} email={null} {...props} />,
    );

  it("shows the link a student really opens, not the shape that 404s", () => {
    // `wise.com/pay/<handle>` — what the old hint spelled out — has not
    // resolved since 2026-05. buildWisePayUrl has always produced the `/me/`
    // form; the field that must be exactly right was illustrated with the one
    // that does not work.
    const html = render({ handle: "anateacher" });
    expect(html).toContain("https://wise.com/pay/me/anateacher");
    expect(html).not.toMatch(/wise\.com\/pay\/(?!me\/)/);
  });

  it("names what a Wisetag may contain before a round trip spends one", () => {
    const html = render({ handle: "not a wisetag" });
    expect(html).toContain(c("web.settings.payments.wisetagInvalid"));
    expect(html).not.toContain("https://wise.com/pay/me/not");
  });

  it("attaches the toggle's explanation to the toggle", () => {
    // A sibling <p> is read by nobody: the label alone tells a screen-reader
    // user nothing about what turning it on does.
    const html = render();
    expect(html).toContain('aria-describedby="wise-enabled-hint"');
    expect(html).toContain('id="wise-enabled-hint"');
    expect(html).toContain(c("web.settings.payments.wiseEnableHint"));
  });

  it("keeps the label the E2E and every teacher reads", () => {
    expect(render()).toContain(c("web.settings.payments.wiseEnableLabel"));
    expect(render()).toContain(c("web.settings.payments.wisetagLabel"));
  });
});
