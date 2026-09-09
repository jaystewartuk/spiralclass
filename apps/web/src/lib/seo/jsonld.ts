// schema.org JSON-LD builders for the public pages. Pure functions returning
// plain objects — rendered via <JsonLd> (src/components/json-ld.tsx).
//
// Deliberately NO AggregateRating / Review markup anywhere: teacher
// testimonials are teacher-curated quotes without ratings, and emitting
// fabricated review markup violates Google's review-snippet policy.

import { LOCALES, languageName } from "@spiralclass/shared";

// Absolute base URL for structured data. JSON-LD can't lean on Next's
// metadataBase the way <head> metadata does, so URLs are built explicitly.
// Read at call time (not module load) so tests can vary APP_URL freely.
export function seoBaseUrl(): string {
  return (process.env.APP_URL ?? "https://spiralclass.com").replace(/\/$/, "");
}

// Money is stored in integer minor units; schema.org wants a decimal string.
function minorUnitsToPrice(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

export function organizationJsonLd(baseUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "SpiralClass",
    url: baseUrl,
    // NOT `/icon.svg`. That is Next's file-convention route, served
    // `immutable, max-age=31536000` at a path that never changes, so a CDN
    // pins it to whatever it cached first — which is how the manifest and the
    // push service worker both ended up serving the PREVIOUS brand's icon
    // months after the rename. JSON-LD is hand-written, so nothing appends the
    // content hash that makes the <head> reference safe.
    //
    // The 512px raster rather than the SVG for a second reason: Google wants
    // an Organization logo it can crop to a square, at least 112x112, and
    // reads a raster more reliably than an SVG.
    logo: `${baseUrl}/brand/icon-maskable-512.png`,
  };
}

export function webSiteJsonLd(baseUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "SpiralClass",
    url: baseUrl,
    inLanguage: LOCALES.map((l) => l.tag),
  };
}

// /pricing — the product with its subscription plans as Offers. The founding
// plan is cohort-gated and deliberately excluded; callers pass the evergreen
// plans from @/lib/subscriptions/config so prices can never drift from the
// source of truth. `currency` is the platform's own canonical billing
// currency (PLATFORM_MONEY_CURRENCY, GBP as of D-99) — these are ALL priced
// in the same currency (a single canonical platform subscription price), so
// one currency for the whole Offers list is correct, unlike
// teacherProfileJsonLd below where each package can carry its own.
export function pricingJsonLd(
  baseUrl: string,
  plans: Array<{ name: string; priceMinorUnits: number }>,
  currency: string,
) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SpiralClass",
    url: `${baseUrl}/pricing`,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Android",
    offers: plans.map((p) => ({
      "@type": "Offer",
      name: p.name,
      price: minorUnitsToPrice(p.priceMinorUnits),
      priceCurrency: currency,
    })),
  };
}

// Landing (/) — the product as a SoftwareApplication with an explicit
// featureList so the AI live-lesson stack (captions, insights, pronunciation,
// SRS, podcasts) and the core capabilities are legible to crawlers. Callers
// pass the already-translated feature names. Deliberately NO offers/ratings
// here — pricing Offers live on /pricing (pricingJsonLd) and review markup is
// banned platform-wide (see the file header).
export function softwareApplicationJsonLd(baseUrl: string, featureList: string[]) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SpiralClass",
    url: baseUrl,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Android",
    featureList,
  };
}

export function faqPageJsonLd(items: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

// ISO 8601 duration for a whole number of minutes ("PT50M") — schema.org's
// `duration`/CourseInstance.duration format. No hour/second rollover: class
// lengths in this product are always sub-2h minutes, so a flat PTxM stays
// both valid and readable.
function minutesToIso8601Duration(min: number): string {
  return `PT${min}M`;
}

// ISO 8601 duration for a whole number of milliseconds ("PT47S") — used for
// VideoObject.duration, which schema.org expects in seconds-granularity.
function msToIso8601Duration(ms: number): string {
  return `PT${Math.max(0, Math.round(ms / 1000))}S`;
}

// Reduces the ASR utterances JSON ([{ text, startMs, endMs }], already ordered
// by startMs — see IntroVideoAnalysis.transcript) to the flat text
// VideoObject.transcript expects. Defensive against a malformed/empty JSON
// blob rather than assuming the shape: returns null (never publish an empty
// transcript claim) instead of throwing.
export function introVideoTranscriptText(utterances: unknown): string | null {
  if (!Array.isArray(utterances)) return null;
  const text = utterances
    .map((u) => (u && typeof u === "object" && "text" in u ? u.text : null))
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return text.length > 0 ? text : null;
}

// /b/[slug] — the teacher's public booking page as a ProfilePage around a
// Person, with her packages as Offers. Fields mirror what the page itself
// renders: headline → jobTitle, bio → description, R2 photo → image.
//
// AI-readability additions (booking-page-ai-readability): `knowsLanguage`,
// each package Offer's `itemOffered` Course (subject/mode/level/area/provider,
// per-package CourseInstance duration), and an optional VideoObject for the
// intro video. Every added field traces to a teacher-entered column and is
// omitted outright when that column is null/empty — never inferred, never a
// plausible-looking default.
export function teacherProfileJsonLd(input: {
  baseUrl: string;
  slug: string;
  name: string;
  headline?: string | null;
  bio?: string | null;
  photoUrl?: string | null;
  // The language she teaches IN (Teacher.teachingLanguage, BCP-47) — always
  // set (DB default "es"), so this is a plain string, not nullable.
  teachingLanguage: string;
  // The subject she teaches (Teacher.targetLanguage, BCP-47) — nullable; a
  // teacher who never set this gets no Course/subject claim at all.
  targetLanguage?: string | null;
  // Her CEFR/custom levels (Teacher.levels, non-archived, position order).
  // Empty = no educationalLevel claim.
  levels?: Array<{ label: string }>;
  // ISO-3166-1 alpha-2 (Teacher.country) — always set (DB default "MX").
  country?: string | null;
  // Each package carries ITS OWN currency (a teacher prices in her own chosen
  // currency — D-64), unlike pricingJsonLd's single platform-wide currency —
  // never hardcode one here. classDurationMin drives each Offer's
  // itemOffered.hasCourseInstance duration.
  packages: Array<{
    name: string;
    priceMinorUnits: number;
    currency: string;
    classDurationMin?: number;
  }>;
  // The intro video (D-73), when recorded. `transcriptText` is ONLY passed
  // when the teacher has opted in (introVideoTranscriptPublicOptIn) AND a
  // transcript actually exists — the caller decides that, not this builder.
  video?: {
    url: string;
    durationMs?: number | null;
    transcriptText?: string | null;
  } | null;
}) {
  const url = `${input.baseUrl}/b/${input.slug}`;
  const person: Record<string, unknown> = {
    "@type": "Person",
    name: input.name,
    url,
  };
  const headline = input.headline?.trim();
  if (headline) person.jobTitle = headline;
  const bio = input.bio?.trim();
  if (bio) person.description = bio;
  if (input.photoUrl) person.image = input.photoUrl;

  // The language she teaches IN — a plain fact about her, not about the
  // subject. Always present (non-null column).
  if (input.teachingLanguage) {
    person.knowsLanguage = {
      "@type": "Language",
      name: languageName(input.teachingLanguage),
      alternateName: input.teachingLanguage,
    };
  }

  // The subject Course, shared by reference across every package Offer below
  // (schema.org's idiomatic Offer.itemOffered — a Course being offered at a
  // price — rather than a bespoke Person-level property that doesn't exist in
  // the vocabulary). Built only when targetLanguage is set: a teacher who
  // never named her subject gets no Course claim, not a guessed one.
  const targetLanguage = input.targetLanguage?.trim();
  const course: Record<string, unknown> | null = targetLanguage
    ? {
        "@type": "Course",
        name: `${languageName(targetLanguage)} lessons`,
        about: languageName(targetLanguage),
        provider: { "@type": "Person", name: input.name },
        inLanguage: input.teachingLanguage,
        courseMode: "online",
      }
    : null;
  if (course) {
    const levels = (input.levels ?? []).filter((l) => l.label.trim());
    if (levels.length > 0) {
      course.educationalLevel = levels.map((l) => l.label.trim()).join(", ");
    }
    const country = input.country?.trim();
    if (country) course.areaServed = { "@type": "Country", name: country };
  }

  if (input.packages.length > 0) {
    person.makesOffer = input.packages.map((p) => {
      const offer: Record<string, unknown> = {
        "@type": "Offer",
        name: p.name,
        price: minorUnitsToPrice(p.priceMinorUnits),
        priceCurrency: p.currency,
        url: `${url}/buy`,
      };
      if (course) {
        offer.itemOffered =
          p.classDurationMin != null
            ? {
                ...course,
                hasCourseInstance: {
                  "@type": "CourseInstance",
                  courseMode: "online",
                  duration: minutesToIso8601Duration(p.classDurationMin),
                },
              }
            : course;
      }
      return offer;
    });
  }

  // The intro video (D-73) — richer content than the 280-char bio, and
  // otherwise invisible to a text crawler. `transcript` only appears when the
  // caller passed one (teacher opted in AND it exists); the video markup
  // itself doesn't depend on that opt-in, since the video is already public.
  if (input.video?.url) {
    const video: Record<string, unknown> = {
      "@type": "VideoObject",
      name: `${input.name} — intro video`,
      contentUrl: input.video.url,
    };
    if (input.photoUrl) video.thumbnailUrl = input.photoUrl;
    if (input.video.durationMs != null) {
      video.duration = msToIso8601Duration(input.video.durationMs);
    }
    const transcript = input.video.transcriptText?.trim();
    if (transcript) video.transcript = transcript;
    person.subjectOf = video;
  }

  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url,
    mainEntity: person,
  };
}
