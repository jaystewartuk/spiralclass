import { describe, expect, it } from "vitest";
import { strings } from "./catalog";
import {
  LOCALES,
  DEFAULT_LOCALE,
  SYSTEM_LOCALE,
  LANGUAGE_CODES,
  isAppLocale,
  isLocalePreference,
  resolveLocale,
  localeOptions,
  matchAcceptLanguage,
  localeToLanguageCode,
  languageCodeToLocale,
} from "./locales";
import { createT, interpolate, translate } from "./translate";

describe("locale registry", () => {
  it("exposes every registered locale as a catalog block", () => {
    for (const locale of LOCALES) {
      expect(strings[locale.tag]).toBeDefined();
    }
  });

  it("keeps every locale key-complete against the source locale", () => {
    // The type-level guard enforces this at compile time; this asserts it at
    // runtime too, so a hand-edit that somehow bypasses tsc still fails CI.
    const sourceKeys = Object.keys(strings["es-MX"]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(strings[locale.tag]).sort()).toEqual(sourceKeys);
    }
  });

  it("isAppLocale accepts registered tags and rejects others", () => {
    expect(isAppLocale("es-MX")).toBe(true);
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("fr")).toBe(true);
    expect(isAppLocale("pt-BR")).toBe(false);
    expect(isAppLocale(undefined)).toBe(false);
  });

  it("matchAcceptLanguage picks the locale for a header prefix", () => {
    expect(matchAcceptLanguage("es-MX,es;q=0.9")).toBe("es-MX");
    expect(matchAcceptLanguage("en-GB,en;q=0.8")).toBe("en");
    expect(matchAcceptLanguage("fr-FR,fr;q=0.9")).toBe("fr");
    expect(matchAcceptLanguage("fr-CA")).toBe("fr");
    // A locale not in the registry still resolves to null (caller defaults).
    expect(matchAcceptLanguage("pt-BR")).toBeNull();
    expect(matchAcceptLanguage("")).toBeNull();
  });

  it("bridges locales to the underscore languageCode used by outbound copy", () => {
    expect(localeToLanguageCode("es-MX")).toBe("es_MX");
    expect(localeToLanguageCode("en")).toBe("en");
    expect(localeToLanguageCode("en-US")).toBe("en");
    expect(localeToLanguageCode("fr")).toBe("fr");
    expect(localeToLanguageCode("fr-FR")).toBe("fr");
    // Unknown input preserves the historical Spanish default.
    expect(localeToLanguageCode("de")).toBe("es_MX");
    expect(localeToLanguageCode(null)).toBe("es_MX");
    expect(LANGUAGE_CODES).toContain(DEFAULT_LOCALE === "en" ? "en" : "es_MX");
  });

  it("languageCodeToLocale bridges the underscore languageCode back to a tag", () => {
    expect(languageCodeToLocale("es_MX")).toBe("es-MX");
    expect(languageCodeToLocale("en")).toBe("en");
    expect(languageCodeToLocale("fr")).toBe("fr");
    // Unknown/missing input falls back to the platform default, not a
    // hardcoded locale — this direction has no historical default to keep.
    expect(languageCodeToLocale("fr_FR")).toBe(DEFAULT_LOCALE);
    expect(languageCodeToLocale(null)).toBe(DEFAULT_LOCALE);
    expect(languageCodeToLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe("language preference (System Default)", () => {
  it("isLocalePreference accepts locales and the system sentinel", () => {
    expect(isLocalePreference(SYSTEM_LOCALE)).toBe(true);
    expect(isLocalePreference("fr")).toBe(true);
    expect(isLocalePreference("es-MX")).toBe(true);
    expect(isLocalePreference("pt-BR")).toBe(false);
    expect(isLocalePreference(undefined)).toBe(false);
  });

  it("resolveLocale follows the device for 'system', pins an explicit locale", () => {
    // System (or anything unrecognized) tracks the detected device locale live.
    expect(resolveLocale(SYSTEM_LOCALE, "fr")).toBe("fr");
    expect(resolveLocale(SYSTEM_LOCALE, "en")).toBe("en");
    expect(resolveLocale(null, "es-MX")).toBe("es-MX");
    // An explicit choice wins regardless of the device.
    expect(resolveLocale("fr", "en")).toBe("fr");
    expect(resolveLocale("es-MX", "fr")).toBe("es-MX");
  });

  it("localeOptions is generated from the registry: System Default + every locale", () => {
    const options = localeOptions("System Default");
    expect(options[0]).toEqual({ value: SYSTEM_LOCALE, label: "System Default" });
    expect(options.slice(1)).toEqual(LOCALES.map((l) => ({ value: l.tag, label: l.label })));
    // Every registered language is offered, plus the System row.
    expect(options).toHaveLength(LOCALES.length + 1);
    expect(options.map((o) => o.label)).toContain("Français");
  });
});

describe("createT / interpolate", () => {
  it("resolves a key in the requested locale", () => {
    expect(createT("es-MX")("common.save")).toBe("Guardar");
    expect(createT("en")("common.save")).toBe("Save");
    expect(createT("fr")("common.save")).toBe("Enregistrer");
  });

  it("interpolates {var} placeholders", () => {
    expect(createT("en")("home.greeting", { name: "Mira" })).toBe("Hi, Mira");
    expect(interpolate("Paso {n} de 4", { n: 2 })).toBe("Paso 2 de 4");
    expect(interpolate("no vars")).toBe("no vars");
  });

  it("legacy translate() returns the entry for the locale", () => {
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "en")).toBe("Hello");
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "es-MX")).toBe("Hola");
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "fr")).toBe("Bonjour");
  });
});

describe("public marketing copy makes no unverifiable scale claim", () => {
  // The /about founder bio claimed SpiralClass was built for Alicia Moreno "and
  // now for hundreds of other teachers" ("cientos de maestros más"). Nothing on
  // the platform supports that number — the unfreeze trigger
  // at 5+ paying teachers — and the site is a case study a prospective client
  // may probe, so a headcount that can't be substantiated costs more than it
  // wins. The copy now claims only what is true regardless of the count: the
  // product was proven in real classes.
  //
  // This guards the DECISION, not the wording — rephrase the bios freely, just
  // don't reintroduce a number nobody can check. If SpiralClass genuinely
  // reaches a scale worth naming, state the real figure and update this test.
  //
  // Scoped to a headcount OF TEACHERS, deliberately. A bare "millions" regex
  // also flagged web.about.trust.stripe.body — "Stripe, the same processor used
  // by Amazon and millions of businesses worldwide" — which is a true claim
  // about STRIPE's scale, not ours, and is exactly the kind of third-party
  // credibility signal the page should keep. Our customers are teachers, so a
  // quantifier next to a teacher noun is the shape that can only be a claim
  // about us.
  const SCALE_CLAIMS = [
    /\b(hundreds|thousands|millions)\s+of\s+(\w+\s+){0,2}teachers\b/i,
    /\b(cientos|miles|millones)\s+de\s+(\w+\s+){0,2}(maestr|profesor)/i,
    /\b(centaines|milliers|millions)\s+d[e']\s*(\w+\s+){0,2}(enseignant|professeur)/i,
  ];

  // Every public marketing surface, not just the bio the claim was found in.
  const PUBLIC_PREFIXES = ["web.about.", "web.home.", "web.features.", "web.pricing."];

  for (const locale of LOCALES) {
    it(`has no unbacked headcount in ${locale.tag} marketing copy`, () => {
      const catalog = strings[locale.tag] as Record<string, string>;
      for (const [key, value] of Object.entries(catalog)) {
        if (!PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (typeof value !== "string") continue;
        for (const claim of SCALE_CLAIMS) {
          expect(claim.test(value), `${key} claims scale: "${value}"`).toBe(false);
        }
      }
    });
  }
});

describe("the marketing copy sells to teachers of any subject", () => {
  // The landing eyebrow read "For teachers of any language" while the manifest,
  // the Open Graph subtitle, the layout description and the features headline
  // beside it already said "any subject" — the same page made two different
  // promises about who the product is for. Subject is the one that stands:
  // nothing in the funnel, the payment rails or the reminders is about
  // languages, and a music or a maths teacher reading "any language" reads
  // herself out of the product.
  //
  // This guards the DECISION, not the wording — rephrase the marketing freely,
  // just don't scope the AUDIENCE to language teaching again. It says nothing
  // about the schema, where a teacher's subject is still a BCP-47 code in
  // `teachers.target_language`; widening that column is its own change.
  //
  // Scoped to a language word next to a TEACHER noun, deliberately. A bare
  // /language/ also flags "feedback in your language" (the UI language of the
  // AI's reply) and "a plain-language privacy notice" — neither is a claim
  // about who may sign up.
  const AUDIENCE_SCOPED_TO_LANGUAGES = [
    /\b(any|every|all)\s+languages?\b/i,
    /\blanguages?\s+(teacher|teachers|teaching)\b/i,
    /\b(teacher|teachers|profs?)\s+of\s+(any|every|all)?\s*languages?\b/i,
    /\b(maestr|profesor|profes)\w*\s+de\s+(cualquier\s+)?idiomas?\b/i,
    /\bcualquier\s+idioma\b/i,
    /\b(el\s+)?idioma\s+que\s+ense/i,
    /\b(enseignant|professeur|prof)\w*\s+de\s+(toute\s+|n'importe\s+quelle\s+)?langues?\b/i,
    /\b(toute|n'importe quelle)\s+langue\b/i,
  ];

  // Every public marketing surface — the pages a teacher reads before she has
  // an account, plus the metadata a link preview renders from.
  const PUBLIC_PREFIXES = [
    "landing.",
    "web.landing.",
    "web.features.",
    "web.about.",
    "web.pricing.",
    "web.layout.",
    "web.manifest.",
    "web.og.",
  ];

  for (const locale of LOCALES) {
    it(`scopes the audience by subject, not by language, in ${locale.tag}`, () => {
      const catalog = strings[locale.tag] as Record<string, string>;
      for (const [key, value] of Object.entries(catalog)) {
        if (!PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (typeof value !== "string") continue;
        for (const claim of AUDIENCE_SCOPED_TO_LANGUAGES) {
          expect(claim.test(value), `${key} sells to language teachers: "${value}"`).toBe(false);
        }
      }
    });
  }
});

describe("no internal spec references in user-facing copy", () => {
  // Four strings shipped "(teacher overrides)" / "(blocked dates)" to teachers in all three
  // languages — section numbers from an internal spec that no reader has, let
  // alone one that still exists. They also break text-to-speech, which reads
  // "§" as nothing at all.
  it("ships no § section reference in any locale", () => {
    for (const [locale, catalog] of Object.entries(strings)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value !== "string") continue;
        expect(`${locale}/${key}: ${value}`).not.toMatch(/§\s*\d/);
      }
    }
  });
});

describe("no user-facing copy carries the pre-D-138 product name", () => {
  // D-138 (2026-08-29) renamed the product to SpiralClass across 934 files and
  // deliberately preserved 45 identifiers naming live external resources — Fly
  // apps, R2 buckets, the Inngest app id, Sentry issue short ids. That protect
  // list is the reason the old name is still greppable in this repo at all,
  // and it is exactly why a stray one in READER-FACING copy would not stand
  // out: "there are hundreds of them, they are all deliberate" is true of the
  // infrastructure strings and false of anything in this catalog.
  //
  // Nothing in `strings` names infrastructure. Every value here is read by a
  // teacher or a student, so the allowed count is zero, in every locale, with
  // no exceptions to maintain.
  //
  // Scoped to the catalog rather than the whole tree on purpose: CLAUDE.md's
  // i18n rule is that all web copy resolves through these keys, so this IS the
  // user-facing surface — and a repo-wide grep would need a per-line allowlist
  // of the preserved identifiers, which rots the moment infrastructure moves.
  const RETIRED_NAME = /agenda\s*profe/i;

  it("ships no locale value naming the old product", () => {
    for (const [locale, catalog] of Object.entries(strings)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value !== "string") continue;
        expect(`${locale}/${key}: ${value}`).not.toMatch(RETIRED_NAME);
      }
    }
  });

  it("still matches the name it is guarding against", () => {
    // Guards the guard: a regex that matched nothing would pass the assertion
    // above against a catalog full of the old name.
    expect("AgendaProfe").toMatch(RETIRED_NAME);
    expect("agenda profe").toMatch(RETIRED_NAME);
    expect("SpiralClass").not.toMatch(RETIRED_NAME);
  });
});

describe("the card fee is disclosed, and attributed to Stripe (D-152)", () => {
  // D-143 made the TEACHER the merchant of record: a card charge settles on her
  // own connected account and Stripe bills its processing fee there, where the
  // platform never sees it. Two failure modes follow, and this guards both.
  //
  // 1. The platform kept promising things that stopped being true. Copy still
  //    said card payments arrive lower "after Stripe's fee and the platform
  //    commission" — a commission D-143 abolished — while /pricing promised
  //    "getting paid by your students is always free" beside a "0% take-rate"
  //    claim, with nothing anywhere naming the fee she actually meets.
  // 2. The one place that DID name a number attributed OUR deliberately-high
  //    worst-case estimate to Stripe as its rate ("Stripe charges you up to
  //    ~5.25%"). That is wrong for nearly every teacher — Stripe UK domestic is
  //    1.5% — and is a price claim the platform cannot stand behind.
  //
  // These tests guard the DECISION, not the wording: rewrite the sentences
  // freely, just don't reintroduce a commission we don't charge, and don't
  // present our estimate as Stripe's rate.

  const CATALOGS = Object.entries(strings) as [string, Record<string, string>][];

  // "Platform commission" / "marketplace commission" in any locale. The
  // AMBASSADOR commission is real and still paid, so the pattern requires the
  // platform/marketplace qualifier rather than the bare word.
  const RETIRED_COMMISSION = [
    /\b(platform|marketplace)\s+commission\b/i,
    /\bcomisi[óo]n\s+de\s+(la\s+)?(plataforma|marketplace|mercado)\b/i,
    /\bcommission\s+de\s+(la\s+)?(plateforme|marketplace)\b/i,
  ];

  // A sentence may still SAY we take no marketplace commission — that is the
  // disclosure, not a violation of it.
  const DENIAL =
    /\bno\b|\bnever\b|\bnot\b|\b0\s*%|\bzero\b|\bretired\b|\bonly\b|\bsin\b|\bninguna\b|\bnada\b|\búnica\b|\bunica\b|\baucune\b|\bseule\b|\brestante\b/i;

  for (const [locale, catalog] of CATALOGS) {
    it(`never charges a platform commission in ${locale}`, () => {
      const offenders: string[] = [];
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value !== "string" || DENIAL.test(value)) continue;
        if (RETIRED_COMMISSION.some((pattern) => pattern.test(value))) {
          offenders.push(`${key}: "${value}"`);
        }
      }
      expect(
        offenders,
        `these strings charge a commission D-143 abolished:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }

  // The platform's worst-case estimate, as a bare percentage. Wherever a number
  // appears it must be interpolated from STRIPE_WORST_CASE_RATE via {rate}, so
  // the sentence cannot drift from the arithmetic that sizes the discount.
  for (const [locale, catalog] of CATALOGS) {
    it(`hardcodes no card-fee percentage in ${locale}`, () => {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value !== "string") continue;
        expect(
          /~?\s*5[.,]25\s*%/.test(value),
          `${locale}/${key} hardcodes the worst-case rate instead of interpolating {rate}: "${value}"`,
        ).toBe(false);
      }
    });
  }

  // Wherever a rate IS named, the sentence must say it is our estimate rather
  // than Stripe's rate. `{rate}` is only ever the platform's worst case.
  // Scoped to the card-fee hint by key: `{rate}` also carries an FX rate on the
  // admin economics screens, which is a different number with different rules.
  const FEE_RATE_KEYS = ["onboarding.templates.wiseDiscountHint"];

  for (const [locale, catalog] of CATALOGS) {
    it(`attributes the {rate} estimate to us, not to Stripe, in ${locale}`, () => {
      for (const key of FEE_RATE_KEYS) {
        const value = catalog[key];
        expect(typeof value, `${locale} is missing ${key}`).toBe("string");
        expect(value, `${locale}/${key} must interpolate {rate}`).toContain("{rate}");
        const ownsTheEstimate =
          /\b(our|we|us)\b/i.test(value) ||
          /\b(nuestr|calculamos|supusimos)/i.test(value) ||
          /\b(notre|nous)\b/i.test(value);
        expect(
          ownsTheEstimate,
          `${locale}/${key} names a rate without owning it as our estimate: "${value}"`,
        ).toBe(true);
      }
    });
  }

  // The disclosure has to actually exist on the three surfaces a teacher meets
  // the cost on: the public pricing page, her billing page, and her payments
  // settings. A key that quietly disappears takes the disclosure with it.
  const REQUIRED_KEYS = [
    "web.pricing.fees.title",
    "web.pricing.fees.platformBody",
    "web.pricing.fees.processorBody",
    "web.pricing.fees.transferBody",
    "web.pricing.fees.stripeLink",
    "web.settings.billing.feesTitle",
    "web.settings.billing.feesBody",
    "web.settings.payments.feesTitle",
    "web.settings.payments.feesBody",
  ];

  for (const [locale, catalog] of CATALOGS) {
    it(`ships the fee disclosure in ${locale}`, () => {
      for (const key of REQUIRED_KEYS) {
        expect(typeof catalog[key], `${locale} is missing ${key}`).toBe("string");
        expect(catalog[key]!.length, `${locale}/${key} is empty`).toBeGreaterThan(0);
      }
    });
  }

  // "Getting paid by your students is always free" was the single most
  // misleading sentence on the platform: true of SpiralClass's charge, false as
  // a description of what getting paid costs her, and it shipped in FIVE places
  // — /pricing's subtitle and meta description, the web and mobile billing
  // subtitles, and the billing help hint. Two of them survived the first pass of
  // this very decision, which is why the rule is a test rather than a habit.
  //
  // Saying a PLAN is free is fine. Saying GETTING PAID is free is not, because
  // Stripe's fee makes it untrue.
  const FREE_TO_GET_PAID = [
    /\bgetting paid\b[^.]*\bfree\b/i,
    /\bpaid by\s+(your\s+)?students\b[^.]*\bfree\b/i,
    /\bcobrar(?:les)?\b[^.]*\bgratis\b/i,
    /\b[êe]tre pay[ée]+\b[^.]*\bgratuit/i,
  ];

  for (const [locale, catalog] of CATALOGS) {
    it(`never claims getting paid is free in ${locale}`, () => {
      const offenders: string[] = [];
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value !== "string") continue;
        if (FREE_TO_GET_PAID.some((pattern) => pattern.test(value))) {
          offenders.push(`${key}: "${value}"`);
        }
      }
      expect(
        offenders,
        `these strings say getting paid is free, which Stripe's fee makes untrue:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }

  // Each disclosure body must name Stripe as the one charging the fee. The
  // whole point is that the teacher can tell whose cost it is.
  for (const [locale, catalog] of CATALOGS) {
    it(`names Stripe as the party charging the fee in ${locale}`, () => {
      for (const key of [
        "web.pricing.fees.processorBody",
        "web.settings.billing.feesBody",
        "web.settings.payments.feesBody",
      ]) {
        expect(catalog[key], `${locale}/${key} must name Stripe`).toMatch(/Stripe/);
      }
    });
  }
});

describe("package-template validation speaks every locale", () => {
  // These messages used to be an inline `en ? "..." : "..."` ternary inside
  // saveTemplatesAction — two branches on a three-locale platform, so a French
  // teacher who left a package unnamed was answered in Spanish. They live in
  // the catalog now, which the completeness guard above already forces into
  // every locale; what this adds is that each one still says WHICH package,
  // since the index is the only thing distinguishing four near-identical rows.
  const KEYS = [
    "templates.error.name",
    "templates.error.classCount",
    "templates.error.duration",
    "templates.error.price",
    "templates.error.expiration",
    "templates.error.generic",
  ] as const;

  for (const locale of LOCALES) {
    it(`names the offending package in ${locale.tag}`, () => {
      const t = createT(locale.tag);
      for (const key of KEYS) {
        const rendered = t(key, { package: t("web.onboarding.templates.packageN", { n: 3 }) });
        expect(rendered, `${locale.tag}/${key}`).toContain("3");
        expect(rendered, `${locale.tag}/${key}`).not.toContain("{package}");
      }
    });
  }
});
