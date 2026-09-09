import { afterEach, describe, expect, it } from "vitest";
import {
  faqPageJsonLd,
  introVideoTranscriptText,
  organizationJsonLd,
  pricingJsonLd,
  seoBaseUrl,
  softwareApplicationJsonLd,
  teacherProfileJsonLd,
  webSiteJsonLd,
} from "@/lib/seo/jsonld";
import { LOCALES } from "@spiralclass/shared";

// Pins the schema.org builders that feed <JsonLd> on the public pages:
// URL shapes, minor units→decimal price conversion, optional-field omission,
// and — policy, not style — that NO review/rating markup is ever emitted
// (testimonials are unrated teacher-curated quotes; fabricated ratings
// violate Google's review-snippet policy).

const BASE = "https://spiralclass.com";
const ORIGINAL_APP_URL = process.env.APP_URL;

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = ORIGINAL_APP_URL;
  }
});

describe("seoBaseUrl", () => {
  it("defaults to the production domain", () => {
    delete process.env.APP_URL;
    expect(seoBaseUrl()).toBe("https://spiralclass.com");
  });

  it("uses APP_URL and strips a trailing slash", () => {
    process.env.APP_URL = "https://preview.spiralclass.com/";
    expect(seoBaseUrl()).toBe("https://preview.spiralclass.com");
  });
});

describe("organizationJsonLd / webSiteJsonLd", () => {
  it("builds an Organization with absolute logo URL", () => {
    expect(organizationJsonLd(BASE)).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "SpiralClass",
      url: BASE,
      logo: `${BASE}/brand/icon-maskable-512.png`,
    });
  });

  it("takes the logo from a path whose content cannot go stale behind a cache", () => {
    // `/icon.svg` is Next's file-convention route, served immutable at a path
    // that never changes; only the <head> references Next renders itself carry
    // the content hash that makes that safe. JSON-LD is hand-written, so this
    // handed Google a logo the edge could pin to a retired brand — the same
    // bug the manifest and the push service worker each shipped.
    expect(organizationJsonLd(BASE).logo).not.toContain("/icon.svg");
    // And a raster Google will accept: at least 112px square, not an SVG.
    expect(organizationJsonLd(BASE).logo).toMatch(/\.png$/);
  });

  it("builds a WebSite declaring every registered content language", () => {
    const site = webSiteJsonLd(BASE);
    expect(site["@type"]).toBe("WebSite");
    expect(site.url).toBe(BASE);
    // Derived from the shared LOCALES registry, so a new language is declared
    // here automatically (es-MX, en, fr, …).
    expect(site.inLanguage).toEqual(LOCALES.map((l) => l.tag));
    expect(site.inLanguage).toContain("fr");
  });
});

describe("pricingJsonLd", () => {
  it("maps plans to Offers in the passed currency, with decimal prices", () => {
    const data = pricingJsonLd(
      BASE,
      [
        { name: "Free", priceMinorUnits: 0 },
        { name: "Pro Monthly", priceMinorUnits: 799 },
        { name: "Pro Annual", priceMinorUnits: 7_990 },
      ],
      "GBP",
    );
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.url).toBe(`${BASE}/pricing`);
    expect(data.offers).toEqual([
      { "@type": "Offer", name: "Free", price: "0.00", priceCurrency: "GBP" },
      { "@type": "Offer", name: "Pro Monthly", price: "7.99", priceCurrency: "GBP" },
      { "@type": "Offer", name: "Pro Annual", price: "79.90", priceCurrency: "GBP" },
    ]);
  });
});

describe("softwareApplicationJsonLd", () => {
  it("builds a SoftwareApplication carrying the passed featureList", () => {
    const features = ["Live captions", "AI lesson insights", "Pronunciation scoring"];
    const data = softwareApplicationJsonLd(BASE, features);
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.url).toBe(BASE);
    expect(data.applicationCategory).toBe("BusinessApplication");
    expect(data.operatingSystem).toBe("Web, Android");
    expect(data.featureList).toEqual(features);
  });

  it("carries no offers or ratings (pricing lives on /pricing; reviews are banned)", () => {
    const serialized = JSON.stringify(softwareApplicationJsonLd(BASE, ["x"]));
    expect(serialized).not.toContain("offers");
    expect(serialized).not.toContain("AggregateRating");
    expect(serialized).not.toContain("aggregateRating");
    expect(serialized).not.toContain('"Review"');
  });
});

describe("faqPageJsonLd", () => {
  it("maps Q&A pairs to Question/Answer entities", () => {
    const data = faqPageJsonLd([
      { question: "¿Cómo funciona?", answer: "Así." },
      { question: "¿Cuánto cuesta?", answer: "Depende." },
    ]);
    expect(data["@type"]).toBe("FAQPage");
    expect(data.mainEntity).toHaveLength(2);
    expect(data.mainEntity[0]).toEqual({
      "@type": "Question",
      name: "¿Cómo funciona?",
      acceptedAnswer: { "@type": "Answer", text: "Así." },
    });
  });
});

describe("teacherProfileJsonLd", () => {
  const full = {
    baseUrl: BASE,
    slug: "mira",
    name: "Alicia Moreno",
    headline: "Clases de español con confianza",
    bio: "Doy clases desde 2015.",
    photoUrl: "https://pub-x.r2.dev/mira.jpg?v=1",
    teachingLanguage: "es",
    packages: [
      { name: "10 clases", priceMinorUnits: 150_000, currency: "MXN" },
      { name: "Clase suelta", priceMinorUnits: 20_000, currency: "MXN" },
    ],
  };

  it("builds a ProfilePage around a Person with her packages as Offers", () => {
    const data = teacherProfileJsonLd(full);
    expect(data["@type"]).toBe("ProfilePage");
    expect(data.url).toBe(`${BASE}/b/mira`);
    const person = data.mainEntity as Record<string, unknown>;
    expect(person["@type"]).toBe("Person");
    expect(person.name).toBe("Alicia Moreno");
    expect(person.jobTitle).toBe("Clases de español con confianza");
    expect(person.description).toBe("Doy clases desde 2015.");
    expect(person.image).toBe(full.photoUrl);
    expect(person.makesOffer).toEqual([
      {
        "@type": "Offer",
        name: "10 clases",
        price: "1500.00",
        priceCurrency: "MXN",
        url: `${BASE}/b/mira/buy`,
      },
      {
        "@type": "Offer",
        name: "Clase suelta",
        price: "200.00",
        priceCurrency: "MXN",
        url: `${BASE}/b/mira/buy`,
      },
    ]);
  });

  // D-64 lets a teacher price her packages in her own chosen currency
  // (GBP/USD/EUR/MXN/COP/ARS/CLP/PEN/BRL) — this must never be hardcoded to
  // MXN regardless of what the teacher actually picked.
  it("uses each package's OWN currency, not a hardcoded one", () => {
    const data = teacherProfileJsonLd({
      ...full,
      packages: [
        { name: "10 clases", priceMinorUnits: 15_000, currency: "GBP" },
        { name: "Clase suelta", priceMinorUnits: 2_000, currency: "USD" },
      ],
    });
    const person = data.mainEntity as Record<string, unknown>;
    expect(person.makesOffer).toEqual([
      {
        "@type": "Offer",
        name: "10 clases",
        price: "150.00",
        priceCurrency: "GBP",
        url: `${BASE}/b/mira/buy`,
      },
      {
        "@type": "Offer",
        name: "Clase suelta",
        price: "20.00",
        priceCurrency: "USD",
        url: `${BASE}/b/mira/buy`,
      },
    ]);
  });

  it("omits headline/bio/photo/offers when absent (no empty fields in the markup)", () => {
    const data = teacherProfileJsonLd({
      baseUrl: BASE,
      slug: "mira",
      name: "Alicia Moreno",
      headline: "   ",
      bio: null,
      photoUrl: null,
      teachingLanguage: "es",
      packages: [],
    });
    const person = data.mainEntity as Record<string, unknown>;
    expect(person).not.toHaveProperty("jobTitle");
    expect(person).not.toHaveProperty("description");
    expect(person).not.toHaveProperty("image");
    expect(person).not.toHaveProperty("makesOffer");
  });

  it("never emits review or rating markup (Google review-snippet policy)", () => {
    const serialized = JSON.stringify(teacherProfileJsonLd(full));
    expect(serialized).not.toContain("AggregateRating");
    expect(serialized).not.toContain("aggregateRating");
    expect(serialized).not.toContain("reviewRating");
    expect(serialized).not.toContain('"Review"');
  });

  it("always declares knowsLanguage from teachingLanguage (non-null column)", () => {
    const data = teacherProfileJsonLd(full);
    const person = data.mainEntity as Record<string, unknown>;
    expect(person.knowsLanguage).toEqual({
      "@type": "Language",
      name: "Spanish",
      alternateName: "es",
    });
  });

  it("wraps each package Offer's itemOffered in a Course when targetLanguage is set", () => {
    const data = teacherProfileJsonLd({
      ...full,
      targetLanguage: "en",
      levels: [{ label: "A1" }, { label: "A2" }],
      country: "MX",
      packages: [
        { name: "10 clases", priceMinorUnits: 150_000, currency: "MXN", classDurationMin: 50 },
      ],
    });
    const person = data.mainEntity as Record<string, unknown>;
    const offers = person.makesOffer as Array<Record<string, unknown>>;
    expect(offers[0].itemOffered).toEqual({
      "@type": "Course",
      name: "English lessons",
      about: "English",
      provider: { "@type": "Person", name: "Alicia Moreno" },
      inLanguage: "es",
      courseMode: "online",
      educationalLevel: "A1, A2",
      areaServed: { "@type": "Country", name: "MX" },
      hasCourseInstance: {
        "@type": "CourseInstance",
        courseMode: "online",
        duration: "PT50M",
      },
    });
  });

  it("omits itemOffered entirely when targetLanguage is not set (no inferred subject)", () => {
    const data = teacherProfileJsonLd(full);
    const person = data.mainEntity as Record<string, unknown>;
    const offers = person.makesOffer as Array<Record<string, unknown>>;
    for (const offer of offers) {
      expect(offer).not.toHaveProperty("itemOffered");
    }
  });

  it("omits educationalLevel/areaServed when levels/country are absent", () => {
    const data = teacherProfileJsonLd({
      ...full,
      targetLanguage: "en",
      packages: [{ name: "Clase suelta", priceMinorUnits: 20_000, currency: "MXN" }],
    });
    const person = data.mainEntity as Record<string, unknown>;
    const offers = person.makesOffer as Array<Record<string, unknown>>;
    const course = offers[0].itemOffered as Record<string, unknown>;
    expect(course).not.toHaveProperty("educationalLevel");
    expect(course).not.toHaveProperty("areaServed");
    expect(course).not.toHaveProperty("hasCourseInstance");
  });

  it("builds a VideoObject with transcript only when the caller passes one", () => {
    const withTranscript = teacherProfileJsonLd({
      ...full,
      video: {
        url: "https://pub-x.r2.dev/mira-intro.mp4",
        durationMs: 47_000,
        transcriptText: "Hi, I'm Mira.",
      },
    });
    const person = withTranscript.mainEntity as Record<string, unknown>;
    expect(person.subjectOf).toEqual({
      "@type": "VideoObject",
      name: "Alicia Moreno — intro video",
      contentUrl: "https://pub-x.r2.dev/mira-intro.mp4",
      thumbnailUrl: full.photoUrl,
      duration: "PT47S",
      transcript: "Hi, I'm Mira.",
    });

    // Opted out (or no transcript yet): the video still renders, but with no
    // transcript claim — never publish text the teacher didn't consent to.
    const withoutTranscript = teacherProfileJsonLd({
      ...full,
      video: {
        url: "https://pub-x.r2.dev/mira-intro.mp4",
        durationMs: 47_000,
        transcriptText: null,
      },
    });
    const person2 = withoutTranscript.mainEntity as Record<string, unknown>;
    expect(person2.subjectOf).not.toHaveProperty("transcript");
  });

  it("omits subjectOf entirely when there's no video", () => {
    const data = teacherProfileJsonLd(full);
    const person = data.mainEntity as Record<string, unknown>;
    expect(person).not.toHaveProperty("subjectOf");
  });
});

describe("introVideoTranscriptText", () => {
  it("joins ordered utterances into flat text", () => {
    expect(
      introVideoTranscriptText([
        { text: "Hi, I'm Mira.", startMs: 0, endMs: 1000 },
        { text: "I teach Spanish.", startMs: 1000, endMs: 2500 },
      ]),
    ).toBe("Hi, I'm Mira. I teach Spanish.");
  });

  it("returns null for absent, empty, or malformed input", () => {
    expect(introVideoTranscriptText(null)).toBeNull();
    expect(introVideoTranscriptText(undefined)).toBeNull();
    expect(introVideoTranscriptText([])).toBeNull();
    expect(introVideoTranscriptText([{ text: "   " }])).toBeNull();
    expect(introVideoTranscriptText("not an array")).toBeNull();
    expect(introVideoTranscriptText([{ startMs: 0 }])).toBeNull();
  });
});
