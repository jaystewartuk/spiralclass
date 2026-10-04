import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

// Pins the SEO metadata contract of the public pages: localized titles /
// descriptions, self-referencing canonicals on the indexable marketing
// surface, and `robots: { index: false }` on every utility page that must
// stay out of the index (checkout funnel, auth, email-token pages).
//
// The locale cookie is pinned to es, as in the global tests/setup.ts mock.
// A public page's language comes from its URL (D-193), which the middleware
// hands on as the `x-locale` request header; each case below says which URL
// it renders by setting that header.

const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "locale" ? { value: "es" } : undefined),
  }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));

/** Render as the middleware would for a URL in `locale` (`/es/pricing`). */
function atUrlIn(locale: "en" | "es" | "fr") {
  requestHeaders.set("x-locale", locale);
}

const EVERY_LANGUAGE = (path: string) => ({
  en: path,
  es: path === "/" ? "/es" : `/es${path}`,
  fr: path === "/" ? "/fr" : `/fr${path}`,
  "x-default": path,
});

const teacherFindUnique = vi.fn();
const studentFindFirst = vi.fn();
// No configured social previews — the default for every teacher who has never
// touched the feature, and the case that must leave og:image exactly as it was
// (D-123). The "custom preview overrides og:image" case is covered in
// tests/social-preview/og-metadata.test.ts.
const socialPreviewFindMany = vi.fn(async () => []);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: teacherFindUnique },
    student: { findFirst: studentFindFirst },
    socialPreview: { findMany: socialPreviewFindMany },
  },
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => null),
  getCurrentStudent: vi.fn(async () => null),
  getCurrentTeacher: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/server", () => ({ auth: {} }));
vi.mock("@/lib/env", () => ({
  hasStripeCreds: () => true,
  isSuperuser: () => false,
  isProductionDeployment: () => true,
  serverEnv: () => ({ SESSION_SECRET: "test-secret" }),
}));
vi.mock("@/lib/wise", () => ({
  isWiseReady: () => false,
  buildWisePayUrl: () => "https://wise.com/pay",
}));
vi.mock("@/lib/booking/slot-inputs", () => ({ loadSlotInputs: vi.fn() }));
vi.mock("@/lib/subscriptions/service", () => ({
  getFoundingCohortState: vi.fn(async () => ({ isOpen: false })),
}));
vi.mock("@/lib/notifications/settings-link", () => ({
  resolveNotificationSettingsLink: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
// Client leaf components of the pages under test — irrelevant to metadata.
vi.mock("@/app/b/[slug]/lead-form", () => ({ LeadForm: () => null }));
vi.mock("@/app/b/[slug]/buy/purchase-flow", () => ({ PurchaseFlow: () => null }));
vi.mock("@/app/b/[slug]/buy/result/resend-sign-in-link", () => ({
  ResendSignInLink: () => null,
}));
vi.mock("@/app/actions/transfer-mark-sent", () => ({ markTransferPaymentSentAction: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  requestHeaders.clear();
});

describe("marketing pages — localized metadata + canonicals", () => {
  beforeEach(() => atUrlIn("es"));

  it("landing: absolute tagline title, trial-days description, canonical /es", async () => {
    const { generateMetadata } = await import("@/app/page");
    const meta = await generateMetadata();
    expect(meta.title).toEqual({
      absolute: "SpiralClass — Agenda, cobros y recordatorios para profes",
    });
    expect(meta.description).toContain("30 días de Pro gratis");
    expect(meta.alternates?.canonical).toBe("/es");
    expect(meta.alternates?.languages).toEqual(EVERY_LANGUAGE("/"));
  });

  it("precios: catalog title (no double brand), live price in description, canonical", async () => {
    const { generateMetadata } = await import("@/app/pricing/page");
    const meta = await generateMetadata();
    expect(meta.title).toBe("Precios");
    // Price is interpolated from PLAN_PRICE_MINOR_UNITS (canonical GBP, D-99) so
    // it can never drift. This was two loose `toContain`s while formatMinorUnits
    // rendered GBP as a bare code and then doubled it; now that it renders a
    // symbol plus one code, the literal is assertable — and pinning it here
    // keeps the doubling out of the search-result snippet too.
    expect(meta.description).toContain("£7.99 GBP");
    expect(meta.description).toContain("30 días");
    expect(meta.alternates?.canonical).toBe("/es/pricing");
    expect(meta.alternates?.languages).toEqual(EVERY_LANGUAGE("/pricing"));
  });

  it("help: catalog title + canonical", async () => {
    const { generateMetadata } = await import("@/app/help/page");
    const meta = await generateMetadata();
    expect(meta.title).toBe("Centro de ayuda");
    expect(meta.description).toBeTruthy();
    expect(meta.alternates?.canonical).toBe("/es/help");
    expect(meta.alternates?.languages).toEqual(EVERY_LANGUAGE("/help"));
  });

  it("about + features: canonicals present", async () => {
    const about = await (await import("@/app/about/page")).generateMetadata();
    expect(about.alternates?.canonical).toBe("/es/about");
    const features = await (await import("@/app/features/page")).generateMetadata();
    expect(features.alternates?.canonical).toBe("/es/features");
  });

  // The bare URL is English for everyone, the cookie here included: a crawler
  // sends no cookie, and the page it indexes at /pricing must be the English
  // one. The hreflang set is the same on every URL of the page.
  it("the bare URL: English, canonical to itself, the same hreflang set", async () => {
    atUrlIn("en");
    const meta = await (await import("@/app/pricing/page")).generateMetadata();
    expect(meta.title).toBe("Pricing");
    expect(meta.alternates?.canonical).toBe("/pricing");
    expect(meta.alternates?.languages).toEqual(EVERY_LANGUAGE("/pricing"));
  });
});

describe("legal pages — advertised only in the languages they exist in", () => {
  // Two authored documents exist (D-196): /terms is the English one and
  // /es/terms the Spanish one, and each lists the other. Every other
  // language's URL serves the English document, so it canonicalises to
  // /terms and is not offered to search engines as a French contract.
  it("terms: English at /terms, Spanish at /es/terms, French canonicalising to /terms", async () => {
    const { generateMetadata } = await import("@/app/terms/page");
    const termsLanguages = { en: "/terms", es: "/es/terms", "x-default": "/terms" };

    atUrlIn("en");
    const bare = await generateMetadata();
    expect(bare.title).toBe("Terms of Service");
    expect(bare.alternates?.canonical).toBe("/terms");
    expect(bare.alternates?.languages).toEqual(termsLanguages);

    atUrlIn("es");
    const es = await generateMetadata();
    expect(es.title).toBe("Términos y condiciones");
    expect(es.alternates?.canonical).toBe("/es/terms");
    expect(es.alternates?.languages).toEqual(termsLanguages);

    atUrlIn("fr");
    const fr = await generateMetadata();
    expect(fr.alternates?.canonical).toBe("/terms");
    expect(fr.alternates?.languages).toEqual(termsLanguages);
  });

  // The policy is one English document rendered from @spiralclass/shared
  // (legal copy is never machine-translated — D-81, D-128). Its metadata — the
  // browser tab and the search snippet, which are chrome rather than legal
  // text — follows the URL's language, but every URL canonicalises to the
  // English one.
  it("privacy-notice: one document, metadata in the URL's language, one canonical", async () => {
    atUrlIn("es");
    const { generateMetadata } = await import("@/app/privacy-notice/page");
    const meta = await generateMetadata();
    expect(meta.title).toBe("Política de privacidad");
    expect(meta.description).toBeTruthy();
    expect(meta.alternates?.canonical).toBe("/privacy-notice");
    expect(meta.alternates?.languages).toEqual({
      en: "/privacy-notice",
      "x-default": "/privacy-notice",
    });
  });
});

describe("noindex surfaces", () => {
  it("auth layout: noindex, follow (crawlable so the directive is seen)", async () => {
    const { metadata } = await import("@/app/(auth)/layout");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("checkout funnel (/buy, /buy/result, /buy/transfer/[ref]): noindex, follow", async () => {
    const pages: Array<{ metadata: Metadata }> = [
      await import("@/app/b/[slug]/buy/page"),
      await import("@/app/b/[slug]/buy/result/page"),
      await import("@/app/b/[slug]/buy/transfer/[ref]/page"),
    ];
    for (const page of pages) {
      expect(page.metadata.robots).toEqual({ index: false, follow: true });
    }
  });

  it("email-token pages (/m/login, /r/notif-settings): noindex, nofollow", async () => {
    const pages: Array<{ metadata: Metadata }> = [
      await import("@/app/m/login/page"),
      await import("@/app/r/notif-settings/[token]/page"),
    ];
    for (const page of pages) {
      expect(page.metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});

describe("teacher booking page /b/[slug]", () => {
  const params = Promise.resolve({ slug: "mira" });
  // generateMetadata reads searchParams for `utm_content` (D-123 social
  // previews). Empty here: these cases assert the UNTAGGED link's metadata,
  // which is exactly the path that must stay unchanged.
  const searchParams = Promise.resolve({});

  it("published teacher: canonical + headline title, indexable", async () => {
    teacherFindUnique.mockResolvedValue({
      name: "Alicia Moreno",
      headline: "Clases de español con confianza",
      bio: "Doy clases desde 2015.",
      photoPath: "teachers/t1/photo.jpg",
      onboardingCompleteAt: new Date("2026-01-01"),
      disabledAt: null,
      // isPubliclyListed also requires a
      // reviewed offer/schedule and a connected payout rail.
      templatesTouchedAt: new Date("2026-01-01"),
      availabilityTouchedAt: new Date("2026-01-01"),
      stripeChargesEnabled: true,
      pricingCurrency: "MXN",
      payoutInstruments: [],
      packageTemplates: [{ priceMinorUnits: 150_000 }],
    });
    const { generateMetadata } = await import("@/app/b/[slug]/page");
    const meta = await generateMetadata({ params, searchParams });
    expect(meta.title).toBe("Clases de español con confianza");
    expect(meta.alternates?.canonical).toBe("/b/mira");
    expect(meta.robots).toBeUndefined();
  });

  // The global tests/setup.ts next/headers mock pins the locale cookie to
  // es, so everything below would resolve Spanish if the funnel still
  // followed the request locale. It deliberately does not: /b/** renders in
  // PUBLIC_FUNNEL_LOCALE (lib/i18n.ts) regardless of Accept-Language or
  // cookie. Before that, the landing page flipped to Spanish for a Spanish
  // browser while checkout-form.tsx was hardcoded English — one funnel, two
  // languages, switching at the moment the visitor was asked to pay.
  it("renders in the pinned funnel locale, not the visitor's", async () => {
    teacherFindUnique.mockResolvedValue(null);
    const { generateMetadata } = await import("@/app/b/[slug]/page");
    const meta = await generateMetadata({ params, searchParams });
    // Spanish would be "Página no encontrada".
    expect(meta.title).toBe("Page not found");
  });

  it("pins og:locale so a cached Facebook scrape can't freeze the wrong language", async () => {
    teacherFindUnique.mockResolvedValue({
      name: "Alicia Moreno",
      headline: "Learn Spanish at your own pace",
      bio: "I teach one-on-one Spanish online.",
      photoPath: "teachers/t1/photo.jpg",
      onboardingCompleteAt: new Date("2026-01-01"),
      disabledAt: null,
      templatesTouchedAt: new Date("2026-01-01"),
      availabilityTouchedAt: new Date("2026-01-01"),
      stripeChargesEnabled: true,
      pricingCurrency: "MXN",
      payoutInstruments: [],
      packageTemplates: [{ priceMinorUnits: 150_000 }],
    });
    const { generateMetadata } = await import("@/app/b/[slug]/page");
    const meta = await generateMetadata({ params, searchParams });
    expect(meta.openGraph?.locale).toBe("en_US");
  });

  // The pin above was a hardcoded `en_US`, right while the funnel itself was
  // pinned to English. The funnel has followed `booking_page_locale` since,
  // and og:locale went on saying English: a teacher who sells in Spanish had a
  // Spanish title and description on a card that declared itself English.
  it.each([
    ["es", "es_LA", "Clases con Alicia Moreno"],
    ["fr", "fr_FR", "Cours avec Alicia Moreno"],
  ])(
    "declares og:locale in the language she chose for her booking page (%s)",
    async (bookingPageLocale, ogLocale, title) => {
      teacherFindUnique.mockResolvedValue({
        name: "Alicia Moreno",
        // No headline, so the title is the catalog's own line and shows which
        // language the page resolved.
        headline: null,
        bio: "I teach one-on-one online.",
        bookingPageLocale,
        photoPath: "teachers/t1/photo.jpg",
        onboardingCompleteAt: new Date("2026-01-01"),
        disabledAt: null,
        templatesTouchedAt: new Date("2026-01-01"),
        availabilityTouchedAt: new Date("2026-01-01"),
        stripeChargesEnabled: true,
        pricingCurrency: "MXN",
        payoutInstruments: [],
        packageTemplates: [],
      });
      const { generateMetadata } = await import("@/app/b/[slug]/page");
      const meta = await generateMetadata({ params, searchParams });
      // The card and the copy on it agree, and neither follows the request:
      // the suite's cookie says Spanish for every case here, French included.
      expect(meta.openGraph?.locale).toBe(ogLocale);
      expect(meta.title).toBe(title);
    },
  );

  it("onboarded but not Marketplace Ready (no payout rail): noindex AND the page body 404s", async () => {
    // finishing the 4-step wizard alone
    // no longer makes a teacher publicly listed — she also needs a real
    // profile, a reviewed offer/schedule, and a connected payout rail. This
    // teacher has finished onboarding and has a profile, but never connected
    // Stripe or Wise.
    teacherFindUnique.mockResolvedValue({
      id: "t2",
      name: "Alicia Moreno",
      headline: "Clases de español",
      bio: "Doy clases desde 2015.",
      photoPath: "teachers/t2/photo.jpg",
      updatedAt: new Date("2026-01-01"),
      timezone: "America/Costa_Rica",
      onboardingCompleteAt: new Date("2026-01-01"),
      disabledAt: null,
      templatesTouchedAt: new Date("2026-01-01"),
      availabilityTouchedAt: new Date("2026-01-01"),
      stripeAccountId: null,
      stripeChargesEnabled: false,
      pricingCurrency: "MXN",
      payoutInstruments: [],
      packageTemplates: [{ priceMinorUnits: 150_000 }],
      testimonials: [],
    });
    const page = await import("@/app/b/[slug]/page");

    const meta = await page.generateMetadata({ params, searchParams });
    expect(meta.robots).toEqual({ index: false, follow: false });

    await expect(page.default({ params, searchParams })).rejects.toThrow("NOT_FOUND");
  });

  it("disabled teacher: metadata is noindex AND the page body 404s (regression: it used to render)", async () => {
    const disabled = {
      id: "t1",
      name: "Alicia Moreno",
      headline: null,
      bio: null,
      photoPath: null,
      updatedAt: new Date("2026-01-01"),
      timezone: "America/Costa_Rica",
      onboardingCompleteAt: new Date("2026-01-01"),
      disabledAt: new Date("2026-06-01"),
      stripeAccountId: null,
      stripeChargesEnabled: false,
      pricingCurrency: "MXN",
      payoutInstruments: [],
      packageTemplates: [],
      testimonials: [],
    };
    teacherFindUnique.mockResolvedValue(disabled);
    const page = await import("@/app/b/[slug]/page");

    const meta = await page.generateMetadata({ params, searchParams });
    expect(meta.robots).toEqual({ index: false, follow: false });

    await expect(page.default({ params, searchParams })).rejects.toThrow("NOT_FOUND");
  });

  it("unknown slug: page body 404s", async () => {
    teacherFindUnique.mockResolvedValue(null);
    const page = await import("@/app/b/[slug]/page");
    await expect(page.default({ params, searchParams })).rejects.toThrow("NOT_FOUND");
  });
});
