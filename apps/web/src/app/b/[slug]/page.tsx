import { Heading } from "@/components/ui/heading";
import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { CalendarClock, Clock3, Globe, Quote, ShieldCheck } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { approxUsdAssumptions, approxUsdFrom } from "@/lib/pricing/approx-usd";
import { teacherVideoPublicUrl } from "@/lib/storage/teacher-video";
import { testimonialPhotoPublicUrl } from "@/lib/storage/testimonial-photos";
import { TestimonialBody } from "./testimonial-body";
import { completedClassCounts } from "@/lib/testimonials/eligibility";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPriceForBuyer } from "@/lib/money";
import { INSTRUMENT_READINESS_SELECT, isPubliclyListed } from "@/lib/marketplace-ready";
import { getPublicFunnelT, PUBLIC_FUNNEL_LOCALE } from "@/lib/i18n";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import {
  currencyForTeacher,
  hasOfferableInstrument,
  initialsFrom,
  isOneClassOffering,
} from "@spiralclass/shared";
import { JsonLd } from "@/components/json-ld";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { attributionProperties, currentAttribution } from "@/lib/analytics/attribution";
import { recordBookingPageVisit } from "@/lib/marketing/events";
import { currentRequestIsBot } from "@/lib/marketing/bots";
import { currentVisitorHash } from "@/lib/marketing/visitor";
import { currentPostHogIdentity } from "@/lib/analytics/posthog-cookie";
import { introVideoTranscriptText, seoBaseUrl, teacherProfileJsonLd } from "@/lib/seo/jsonld";
import { resolveSocialPreview } from "@/lib/social-preview/store";
import { LeadForm } from "./lead-form";
import { WhatsAppChatButton } from "./whatsapp-chat-button";
import { IntroVideoCard } from "./intro-video-card";
import { WhatsIncluded } from "./whats-included";

// Single teacher-by-slug loader shared by generateMetadata AND the page
// component. Both run for the SAME request on this — the app's primary
// acquisition surface (the URL teachers share on WhatsApp) — so without
// deduping they fired two DB round-trips per view. `React.cache` memoizes per
// request, collapsing them to one. The select is the superset both callers
// need (the page's full shape covers metadata's name/headline/bio/price bits),
// so the extra columns metadata ignores are free once the row is loaded.
// Cross-request copies (opengraph-image.tsx, buy/page.tsx) are separate
// requests React.cache can't reach — left as-is to avoid staleness risk.
const getTeacherBySlug = cache((slug: string) =>
  prisma.teacher.findUnique({
    where: { bookingSlug: slug },
    select: {
      id: true,
      name: true,
      headline: true,
      bio: true,
      publicWhatsappE164: true,
      photoPath: true,
      introVideoPath: true,
      introVideoDurationMs: true,
      introVideoTranscriptPublicOptIn: true,
      updatedAt: true,
      timezone: true,
      country: true,
      // The subject/medium of instruction (D-72) — legible-to-AI JSON-LD facts
      // (booking-page-ai-readability), null-safe: a teacher who never set
      // targetLanguage produces no "teaches X" claim at all.
      targetLanguage: true,
      teachingLanguage: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      // Gates the vocabulary-review line in the reassurance band: her own
      // "share progress with my students" setting, no platform flag involved.
      shareProgressByDefault: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
      pricingCurrency: true,
      payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      // Non-archived levels, in rank order — feeds the Course's
      // educationalLevel claim. Empty = no such claim (never inferred).
      levels: {
        where: { archived: false },
        orderBy: { position: "asc" },
        select: { label: true },
      },
      packageTemplates: {
        where: { archived: false },
        orderBy: { priceMinorUnits: "asc" },
        select: {
          id: true,
          name: true,
          classCount: true,
          singleClass: true,
          classDurationMin: true,
          priceMinorUnits: true,
          currency: true,
        },
      },
      // Social proof. Published only, in the teacher's manual order. `source`
      // and `studentId` carry the two kinds apart: a `student_submitted` row
      // earns the verified badge below, a curated one renders exactly as it
      // always has.
      testimonials: {
        where: { published: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          authorName: true,
          authorNote: true,
          body: true,
          photoPath: true,
          source: true,
          studentId: true,
        },
      },
    },
  }),
);

// The phone-country the lead form should PREFILL.
//
// It followed the teacher's own country, on the reasoning that a visitor has no
// first-class country of their own and her market is the best available guess.
// That holds for a teacher selling into the market she lives in, and inverts
// for one selling out of it: the live Mexican teacher sells Spanish to English
// speakers, so every visitor was handed a +52 picker and a Mexico City
// placeholder — a small, early signal that the page is not for them.
//
// The funnel locale is the better guess because it is the one field where she
// has already said who her buyers are (booking_page_locale, D-73's fourth
// language field). `maximize()` resolves a bare "en" to US via CLDR's
// likely-subtags data. Falls back to her country when the locale carries no
// region, which is the old behaviour and still the right last resort.
function leadPhoneCountryFor(funnelLocale: string, teacherCountry: string): string {
  try {
    return new Intl.Locale(funnelLocale).maximize().region ?? teacherCountry;
  } catch {
    return teacherCountry;
  }
}

// Per-teacher metadata so a shared link (WhatsApp is the teacher's main
// channel) renders a rich preview with her name + price instead of the
// generic site card, and so Google can index each teacher's page. The
// og:image / twitter:image are supplied automatically by the sibling
// opengraph-image.tsx in this segment.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  // Read for `utm_content` ONLY — the tag shareTaggedUrl() already puts on every
  // per-group link, which is what lets one booking page preview differently in
  // different places (D-123). This page is already dynamic (the body reads
  // cookies via getAuthUser), so consuming searchParams here costs no
  // staticness that wasn't already spent.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { slug } = await params;
  // The funnel locale is the teacher's own booking_page_locale. It picks the
  // catalog AND the price formatting, so a buyer never sees a currency
  // symbol rendered for a market that isn't the one she sells into.
  const funnelLocale = await funnelLocaleForSlug(slug);
  const t = getPublicFunnelT(funnelLocale);
  const teacher = await getTeacherBySlug(slug);

  // Not-yet-Marketplace-Ready / disabled teachers (the page 404s) shouldn't
  // be indexed.
  if (!teacher || !isPubliclyListed(teacher)) {
    return {
      title: t("web.bookingLanding.pageNotFound"),
      robots: { index: false, follow: false },
    };
  }

  const title = teacher.headline?.trim()
    ? teacher.headline
    : t("web.bookingLanding.classesWith", { name: teacher.name });
  const cheapestTemplate = teacher.packageTemplates[0];
  const from = cheapestTemplate?.priceMinorUnits;
  const priceBit =
    from != null
      ? ` ${t("web.bookingLanding.fromPrice", { price: formatPriceForBuyer(from, cheapestTemplate.currency, funnelLocale) })}`
      : "";
  // Prefer the teacher's bio as the social/search description; fall back to a
  // generic line with the starting price.
  const description = teacher.bio?.trim()
    ? teacher.bio.trim()
    : `${t("web.bookingLanding.metaDescription", { name: teacher.name })}${priceBit}`;
  const path = `/b/${slug}`;

  // The teacher's custom social preview for THIS link, if she configured one:
  // the group named by ?utm_content=, else her default, else nothing.
  //
  // `undefined` (not an empty array) is load-bearing. Next merges the
  // file-convention opengraph-image.tsx into the metadata ONLY when
  // openGraph.images is not an own property of what generateMetadata returned
  // (next/dist/lib/metadata/resolve-metadata.js, mergeStaticMetadata). So
  // omitting the key entirely leaves today's card in place byte for byte — which
  // is why every link shared before this feature keeps the preview it has — and
  // setting it overrides cleanly. An empty array would suppress both.
  const utmContent = (await searchParams).utm_content;
  const socialPreview = await resolveSocialPreview(
    teacher.id,
    typeof utmContent === "string" ? utmContent : null,
  );
  const images = socialPreview
    ? [{ url: socialPreview.cardUrl, width: 1200, height: 630 }]
    : undefined;

  // og:url has to CARRY the group tag, or the per-group preview above never
  // reaches Facebook at all.
  //
  // Facebook treats og:url as the canonical identity of the shared object: it
  // fetches the tagged link, reads og:url, and if that differs it re-scrapes
  // the og:url and renders THAT document's tags. Its Sharing Debugger says so
  // outright, printing a "Redirect Path" of `Input URL -> og:url Meta Tag`.
  // So while og:url stayed undecorated, every tagged link collapsed onto the
  // untagged page, which resolves no group preview — the group's card was
  // fetched, discarded, and replaced by the generic one. Confirmed against
  // production on 2026-08-26; WhatsApp and Twitter, which don't re-scrape
  // og:url, were showing the right card the whole time.
  //
  // Only the group tag goes on, never the rest of the UTM set: utm_source and
  // utm_medium vary per channel for the same community, and folding them in
  // would split one group's shares across several Facebook objects. The
  // resulting URL is a FIXPOINT — scraping it resolves the same group, and so
  // emits the same og:url — which is what stops the re-scrape from looping.
  //
  // `alternates.canonical` deliberately stays undecorated: search engines
  // should keep indexing exactly one booking page per teacher. What this gives
  // up is Facebook's like/share consolidation across a teacher's communities,
  // which is the price of the feature working at all.
  const ogUrl = socialPreview?.shareGroupSlug
    ? `${path}?utm_content=${encodeURIComponent(socialPreview.shareGroupSlug)}`
    : path;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: ogUrl,
      type: "website",
      siteName: "SpiralClass",
      ...(images ? { images } : {}),
      // Pinned, like the page body: the share card must not claim es_MX for a
      // page that renders in English. Facebook caches the first scrape, so a
      // locale that varied by the scraper's Accept-Language would freeze
      // whichever one Facebook happened to send first.
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(images ? { images } : {}),
    },
  };
}

export default async function BookingLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // The funnel locale is the teacher's own booking_page_locale. It picks the
  // catalog AND the price formatting, so a buyer never sees a currency
  // symbol rendered for a market that isn't the one she sells into.
  const funnelLocale = await funnelLocaleForSlug(slug);
  const t = getPublicFunnelT(funnelLocale);
  const teacher = await getTeacherBySlug(slug);

  // Must match generateMetadata / the OG image / sitemap.ts / buy/page.tsx:
  // a disabled OR
  // not-yet-Marketplace-Ready teacher's page 404s rather than rendering a
  // live booking UI under a noindex "Page not found" title.
  if (!teacher || !isPubliclyListed(teacher)) {
    notFound();
  }

  // This page is the one URL students know (the teacher shares it on
  // WhatsApp), so a returning student with a live session lands here too —
  // point them at their portal instead of at sign-in. Signed-in teachers
  // previewing their own page just see the regular sign-in link.
  // Class counts behind the verified quotes, read now rather than stored on the
  // testimonial — see completedClassCounts for why a copied number goes stale
  // in the one place this feature is asking to be believed.
  const verifiedStudentIds = teacher.testimonials
    .map((x) => x.studentId)
    .filter((id): id is string => id !== null);
  const classCounts = await completedClassCounts(teacher.id, verifiedStudentIds);

  const user = await getAuthUser();
  const hasStudentSession = user
    ? Boolean(
        await prisma.student.findFirst({
          where: { authUserId: user.id },
          select: { id: true },
        }),
      )
    : false;

  // Headline prices use the Stripe (card) price everywhere — same as the
  // /buy default — so there's no "price jump" between this page and
  // checkout. The lower Wise price is revealed on /buy as a saving.
  const cheapest = teacher.packageTemplates[0];
  const cheapestPrice = cheapest ? cheapest.priceMinorUnits : null;

  /**
   * Which package to point at, and why.
   *
   * The list was previously flat — every option in an identical bordered row,
   * ordered by price, with nothing saying which one a student should want. A
   * flat list makes the cheapest row the default answer by position alone,
   * which is the wrong answer for most students and for the teacher.
   *
   * The hierarchy encodes something true rather than asserted: the lowest
   * price PER CLASS. It is marked only when a multi-class package actually
   * beats every single-class rate on offer — if the packages are priced
   * linearly there is no better value, and claiming one would be a lie the
   * student can check with a calculator. The per-class figure is printed on
   * every row for exactly that reason: the claim is verifiable in place.
   */
  const perClass = (pkg: { priceMinorUnits: number; classCount: number }) =>
    pkg.classCount > 0 ? pkg.priceMinorUnits / pkg.classCount : Infinity;
  const multiClass = teacher.packageTemplates.filter((p) => !isOneClassOffering(p));
  const singleRate = Math.min(
    ...teacher.packageTemplates.filter(isOneClassOffering).map(perClass),
    Infinity,
  );
  const bestValue =
    multiClass.length > 0
      ? multiClass.reduce((best, p) => (perClass(p) < perClass(best) ? p : best))
      : null;
  // A discount worth naming. Under ~3% is rounding, not an offer.
  const bestValueId =
    bestValue && Number.isFinite(singleRate) && perClass(bestValue) <= singleRate * 0.97
      ? bestValue.id
      : null;
  const stripeReady = Boolean(teacher.stripeAccountId && teacher.stripeChargesEnabled);
  // Any offerable instrument, not Wise specifically (D-113).
  const transferReady = hasOfferableInstrument(
    teacher.payoutInstruments,
    currencyForTeacher(teacher),
  );
  // "Talk to her before you pay" leads this page when — and only when — the
  // teacher has opted a WhatsApp number in. It used to be a live video ring,
  // which could only ever reach a teacher already sitting on her dashboard,
  // silently, inside a 45-second window. A prospect who took the strongest
  // offer on the page therefore got "calling…" and then nothing, which is
  // worse for conversion than never having offered. WhatsApp is asynchronous,
  // so a message she reads an hour later still converts.
  //
  // The gate is her number rather than a platform flag for the same reason the
  // old one was her availability toggle: a de-risking offer must only appear
  // when there is a real person behind it. Without a number the card leads
  // with the packages and the contact form below stays the path to her.
  const askFirstWhatsapp = teacher.publicWhatsappE164;
  const leadPhoneCountry = leadPhoneCountryFor(funnelLocale, teacher.country);
  // An approximate USD price beside her own currency.
  //
  // Gated on the FUNNEL LOCALE being English, not on the visitor's IP. Two
  // reasons, and the second is the one that decided it. First, IP is a bad
  // proxy for the audience here: the live Mexican teacher sells Spanish to
  // English speakers, many of them living in Mexico, so a Mexican IP says
  // nothing about whether the reader thinks in pesos. Second,
  // `booking_page_locale` is a decision SHE made about who this page is for —
  // it is the only field on the row that carries that, and D-73 exists because
  // inferring it from anything else was wrong twice.
  //
  // So: a page she chose to sell in English gets the lingua franca of price
  // next to her own currency; a page she sells in Spanish is left alone.
  const approxAssumptions = funnelLocale === "en" ? await approxUsdAssumptions() : null;
  const approxUsdCentsFor = (minorUnits: number, currency: string): number | null =>
    approxAssumptions
      ? (approxUsdFrom(minorUnits, currency, approxAssumptions, new Date())?.centsUsd ?? null)
      : null;
  // Live captions (D-27) are advertised in the reassurance band only when the
  // flag AND the ASR/translation vendors are actually configured.
  const captionsAvailable = liveCaptionsEnabled();
  const tzLabel = teacher.timezone.split("/").pop()?.replace(/_/g, " ") ?? teacher.timezone;
  const photoUrl = teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime());
  // Intro video (D-73). A public R2-hosted file — plays inline via <video>,
  // rendered by IntroVideoCard with a branded play overlay (not the profile
  // photo — that previously duplicated the same headshot twice on the page).
  // Null when the teacher hasn't recorded one or the storage bucket isn't
  // configured yet.
  const introVideoUrl = teacherVideoPublicUrl(teacher.introVideoPath, teacher.updatedAt.getTime());
  // Transcript for the JSON-LD VideoObject (booking-page-ai-readability) —
  // read ONLY when the teacher opted in, so a non-opted-in teacher costs this
  // hot path nothing extra. Absent/opted-out/no-transcript-yet all resolve to
  // null, and teacherProfileJsonLd omits the transcript claim entirely then.
  const introVideoTranscript = teacher.introVideoTranscriptPublicOptIn
    ? introVideoTranscriptText(
        (
          await prisma.introVideoAnalysis.findUnique({
            where: { teacherId: teacher.id },
            select: { transcript: true },
          })
        )?.transcript,
      )
    : null;
  // The teacher row's id is the auth user's id (lib/auth mints it that way), so
  // the owner previewing her own page is a plain id match — no extra query. Used
  // to show the "add a photo" nudge only to her, never to a prospective student.
  const isOwner = Boolean(user && user.id === teacher.id);
  const initials = initialsFrom(teacher.name);

  // Top of the public funnel. Until this existed the page emitted nothing
  // deliberate at all — the first intentional signal was `checkout_started`,
  // several steps and most of the drop-off later, so "where do people leave"
  // was unanswerable. distinctId is the PostHog session id when the browser
  // SDK has one; anonymous visitors never become Persons
  // (person_profiles: "identified_only"), so this keys on the session instead
  // and stays joinable to the client-side events from the same visit.
  const [attribution, phIdentity, visitorHash, isBot] = await Promise.all([
    currentAttribution(),
    currentPostHogIdentity(),
    currentVisitorHash(),
    currentRequestIsBot(),
  ]);
  // The in-product half of the same signal (D-125). PostHog keeps receiving
  // exactly what it received before; this additionally lands the visit in the
  // teacher's own acquisition ledger, which is what makes "which community
  // produced this student" answerable inside the app rather than only to
  // whoever holds a PostHog login. Deduped per browser per 12h, never awaited
  // into the render path's critical work, and never able to fail the page.
  //
  // Bots never reach the ledger (lib/marketing/bots.ts): they carry no cookie,
  // so the dedup could not absorb them and nine in ten requests to this page
  // were never a reader. The PostHog event below still fires for them, tagged
  // — the operator's view keeps full fidelity, the teacher's number does not
  // pay for it.
  if (!isOwner) {
    // Same `after()` discipline as the PostHog flush below: a DB write must
    // never sit in front of the HTML on the hottest page in the product, and a
    // floating promise on a recycled runtime is silently lossy — which would
    // deflate the denominator of every conversion rate on the results screen.
    after(() => recordBookingPageVisit({ teacherId: teacher.id, attribution, visitorHash, isBot }));
  }
  trackServerEvent({
    name: "booking_page_viewed",
    // The browser's own distinct id when we can read it, so this lands on the
    // same person as the visit's $pageview / session recording. On a visitor's
    // very first request that cookie doesn't exist yet — fall back to a
    // per-teacher anonymous bucket rather than minting a random id per render,
    // which would inflate unique-visitor counts on every reload.
    distinctId: phIdentity.distinctId ?? `anon:${teacher.id}`,
    sessionId: phIdentity.sessionId ?? undefined,
    properties: {
      teacherId: teacher.id,
      slug,
      fromPriceMinorUnits: cheapestPrice,
      currency: cheapest?.currency ?? null,
      packageCount: teacher.packageTemplates.length,
      stripeReady,
      transferReady,
      isOwner,
      isBot,
      ...attributionProperties(attribution),
    },
  });
  // Flush AFTER the response, never inside the render.
  //
  // posthog-node's flush is an HTTP POST. Awaiting it here put a third-party
  // network round-trip in front of the HTML on the single hottest page in the
  // product — the one taking the Facebook-group traffic — so a slow PostHog
  // became a slow booking page, and an unreachable one a broken funnel.
  //
  // Not simply dropped, which is what the sibling dashboard/page.tsx does:
  // ANALYTICS.md requires an explicit flush per call site precisely because
  // posthog-node otherwise relies on incidental process longevity ("fine on
  // today's Fly.io persistent container, silently lossy on a more aggressively
  // recycled runtime"). Losing these would silently inflate every conversion
  // rate measured against them, since this event is the funnel's denominator.
  //
  // `after()` gets both: explicitly scheduled per request, run once the
  // response is already on its way out.
  after(() => flushAnalytics());

  return (
    <main className="container py-8 lg:max-w-5xl lg:py-12">
      {/* schema.org Person + Offers for rich results. Deliberately NO
          review/rating markup — testimonials are unrated curated quotes. */}
      <JsonLd
        data={teacherProfileJsonLd({
          baseUrl: seoBaseUrl(),
          slug,
          name: teacher.name,
          headline: teacher.headline,
          bio: teacher.bio,
          photoUrl,
          teachingLanguage: teacher.teachingLanguage,
          targetLanguage: teacher.targetLanguage,
          levels: teacher.levels,
          country: teacher.country,
          packages: teacher.packageTemplates.map((p) => ({
            name: p.name,
            priceMinorUnits: p.priceMinorUnits,
            currency: p.currency,
            classDurationMin: p.classDurationMin,
          })),
          video: introVideoUrl
            ? {
                url: introVideoUrl,
                durationMs: teacher.introVideoDurationMs,
                transcriptText: introVideoTranscript,
              }
            : null,
        })}
      />
      <div className="grid gap-8 lg:grid-cols-2 lg:items-start lg:gap-12">
        {/* Left — the teacher: headline, photo, quick facts, bio. Centered. */}
        <div className="space-y-5 text-center">
          <div className="space-y-3">
            <Heading level={1} className="text-balance lg:text-4xl">
              {teacher.headline?.trim()
                ? teacher.headline
                : t("web.bookingLanding.classesWith", { name: teacher.name })}
            </Heading>
            <p className="text-muted-foreground text-sm">{t("web.bookingLanding.tagline")}</p>
          </div>
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt={teacher.name}
              width={320}
              height={320}
              className="mx-auto h-56 w-56 rounded-2xl border object-cover shadow-xs lg:h-72 lg:w-72"
              priority
            />
          ) : (
            // No photo: a monogram of the same footprint keeps the hero balanced
            // and looks intentional to a student, instead of the column collapsing.
            <div
              aria-hidden
              className="bg-muted mx-auto flex h-56 w-56 items-center justify-center rounded-2xl border shadow-xs lg:h-72 lg:w-72"
            >
              <span className="font-display text-muted-foreground text-6xl font-semibold lg:text-7xl">
                {initials}
              </span>
            </div>
          )}
          {!photoUrl && isOwner && (
            // Owner-only: students never see upload prompts on the public page.
            <p className="text-muted-foreground mx-auto max-w-xs text-xs">
              {t("web.bookingLanding.ownerOnlyPrefix")}
              <Link
                href="/settings/booking-page"
                className="text-foreground hover:text-primary font-medium underline underline-offset-2"
              >
                {t("web.bookingLanding.addProfilePhoto")}
              </Link>
              {t("web.bookingLanding.ownerOnlySuffix")}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Globe className="h-3 w-3" aria-hidden /> {tzLabel}
            </Badge>
            {cheapestPrice != null && (
              <Badge variant="outline" className="gap-1">
                <CalendarClock className="h-3 w-3" aria-hidden />{" "}
                {t("web.bookingLanding.fromPrice", {
                  price: formatPriceForBuyer(cheapestPrice, cheapest.currency, funnelLocale),
                })}
              </Badge>
            )}
            {cheapest && (
              <Badge variant="outline" className="gap-1">
                <Clock3 className="h-3 w-3" aria-hidden />
                {isOneClassOffering(cheapest)
                  ? t("web.bookingLanding.singleClassDuration", {
                      min: cheapest.classDurationMin,
                    })
                  : t("web.bookingLanding.classCountDuration", {
                      count: cheapest.classCount,
                      min: cheapest.classDurationMin,
                    })}
              </Badge>
            )}
          </div>
          {/* The video sits ABOVE the bio, directly under the quick-facts
              badges. It used to be the last element in this column, below the
              full bio — which on a phone (where the two columns stack) put the
              single highest-intent trust asset on the page several screens
              down, after the wall of text it exists to replace. A visitor who
              wants to know "is this teacher a fit?" should meet her before
              being asked to read about her. */}
          {introVideoUrl && (
            <IntroVideoCard
              videoUrl={introVideoUrl}
              teacherName={teacher.name}
              teacherId={teacher.id}
              slug={slug}
            />
          )}
          {teacher.bio?.trim() && (
            <p className="text-foreground/80 mx-auto max-w-prose text-base whitespace-pre-line">
              {teacher.bio.trim()}
            </p>
          )}
        </div>

        {/* Right — the action: packages, then portal/sign-in. Above the fold on desktop. */}
        <div className="space-y-4 lg:sticky lg:top-8">
          {/* New students are this page's main audience (returning students
              mostly re-enter via their emailed link), so the purchase path
              leads and sign-in follows. Sign-in links to /sign-in — the
              shared mint-via-Resend rail — instead of embedding its own
              magic-link form, so there is exactly one passwordless flow. */}
          <Card>
            {teacher.packageTemplates.length > 0 ? (
              <>
                {/* The free intro leads, the packages follow. This card used
                    to open with "First time? Buy a package" over a price list
                    and rank the free intro THIRD — below a Sign in button that
                    only an existing account holder needs. The traffic here is
                    strangers arriving from a social post, so the order was
                    built for the one visitor the page does not get. */}
                <CardHeader className="text-center">
                  <CardTitle as="h2" className="text-xl">
                    {askFirstWhatsapp
                      ? t("web.bookingLanding.firstTimeTitle")
                      : t("web.bookingLanding.packagesHeading")}
                  </CardTitle>
                  <CardDescription>
                    {askFirstWhatsapp
                      ? t("web.bookingLanding.firstTimeBody", { name: teacher.name })
                      : t("web.bookingLanding.packagesHint")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {askFirstWhatsapp && (
                    <WhatsAppChatButton
                      whatsappE164={askFirstWhatsapp}
                      teacherName={teacher.name}
                      teacherId={teacher.id}
                      slug={slug}
                      message={t("web.bookingLanding.whatsappPrefilledMessage", {
                        name: teacher.name,
                      })}
                      label={t("web.bookingLanding.whatsappButton")}
                      variant="default"
                    />
                  )}
                  {askFirstWhatsapp && (
                    <div className="space-y-1 border-t pt-4 text-center">
                      <h3 className="text-sm font-medium">
                        {t("web.bookingLanding.packagesHeading")}
                      </h3>
                      <p className="text-muted-foreground text-xs">
                        {t("web.bookingLanding.packagesHint")}
                      </p>
                    </div>
                  )}
                  <ul className="space-y-2">
                    {teacher.packageTemplates.map((pkg) => (
                      <li key={pkg.id}>
                        <Link
                          href={`/b/${slug}/buy?package=${pkg.id}`}
                          className={
                            pkg.id === bestValueId
                              ? "border-primary bg-background hover:bg-muted/40 flex items-center justify-between gap-3 rounded-md border-2 p-3 text-sm transition-colors"
                              : "bg-background hover:bg-muted/40 flex items-center justify-between gap-3 rounded-md border p-3 text-sm transition-colors"
                          }
                        >
                          <span className="min-w-0">
                            <span className="font-medium">{pkg.name}</span>
                            {pkg.id === bestValueId && (
                              <Badge variant="success" className="ml-2 align-middle">
                                {t("web.bookingLanding.bestValue")}
                              </Badge>
                            )}
                            <span className="text-muted-foreground block text-xs lg:ml-2 lg:inline">
                              {isOneClassOffering(pkg)
                                ? t("web.bookingLanding.singleClassDuration", {
                                    min: pkg.classDurationMin,
                                  })
                                : t("web.bookingLanding.classCountDurationShort", {
                                    count: pkg.classCount,
                                    min: pkg.classDurationMin,
                                  })}
                            </span>
                          </span>
                          <span className="shrink-0 text-right whitespace-nowrap">
                            <span className="block font-semibold tabular-nums">
                              {formatPriceForBuyer(pkg.priceMinorUnits, pkg.currency, funnelLocale)}
                            </span>
                            {/* An approximate USD figure, for a page the
                                teacher chose to sell in English. See the note
                                at approxUsdCentsFor for why that condition and
                                not the visitor's IP.

                                It sits DIRECTLY under the total and above the
                                per-class line, because it approximates the
                                total. Below the per-class line — where it was
                                first written — "MX$325.00 per class / about
                                $75.00" reads as seventy-five dollars per class,
                                which is four times the real figure. An
                                approximation has to touch the number it
                                approximates. */}
                            {approxUsdCentsFor(pkg.priceMinorUnits, pkg.currency) !== null && (
                              <span className="text-muted-foreground block text-xs tabular-nums">
                                {t("web.buyFlow.approxPrice", {
                                  price: formatPriceForBuyer(
                                    approxUsdCentsFor(pkg.priceMinorUnits, pkg.currency)!,
                                    "USD",
                                    funnelLocale,
                                  ),
                                })}
                              </span>
                            )}
                            {/* The per-class figure makes the "best value"
                                mark checkable instead of asserted, and lets a
                                student compare two packages without doing the
                                division herself. */}
                            {pkg.classCount > 1 && (
                              <span className="text-muted-foreground block text-xs tabular-nums">
                                {t("web.bookingLanding.perClass", {
                                  price: formatPriceForBuyer(
                                    Math.round(pkg.priceMinorUnits / pkg.classCount),
                                    pkg.currency,
                                    funnelLocale,
                                  ),
                                })}
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {/* Sign-in is a returning student's errand, not an offer.
                      As a full-width button it outranked the free intro for
                      every stranger on the page; as a text line it stays
                      findable for the person actually looking for it. A
                      signed-in student still gets a real button — for them it
                      IS the next action. */}
                  <div className="border-t pt-4 text-center">
                    {hasStudentSession ? (
                      <div className="space-y-3">
                        <p className="text-muted-foreground text-sm">
                          {t("web.bookingLanding.signedInWaiting")}
                        </p>
                        <Button asChild variant="outline" className="w-full">
                          <Link href="/my-classes">{t("book.confirm.viewMine")}</Link>
                        </Button>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        {t("web.bookingLanding.haveAccountSignIn")}{" "}
                        <Link
                          href="/sign-in"
                          className="text-foreground underline underline-offset-4"
                        >
                          {t("common.signIn")}
                        </Link>
                      </p>
                    )}
                  </div>
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader className="text-center">
                  <CardTitle as="h2" className="text-xl">
                    {hasStudentSession
                      ? t("web.bookingLanding.yourClasses")
                      : t("web.bookingLanding.signInToBook")}
                  </CardTitle>
                  <CardDescription>
                    {hasStudentSession
                      ? t("web.bookingLanding.signedInWaiting")
                      : t("web.bookingLanding.emailSignInHint")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button asChild className="w-full">
                    <Link href={hasStudentSession ? "/my-classes" : "/sign-in"}>
                      {hasStudentSession ? t("book.confirm.viewMine") : t("common.signIn")}
                    </Link>
                  </Button>
                  {askFirstWhatsapp && (
                    <WhatsAppChatButton
                      whatsappE164={askFirstWhatsapp}
                      teacherName={teacher.name}
                      teacherId={teacher.id}
                      slug={slug}
                      message={t("web.bookingLanding.whatsappPrefilledMessage", {
                        name: teacher.name,
                      })}
                      label={t("web.bookingLanding.whatsappButton")}
                      variant="default"
                    />
                  )}
                </CardContent>
              </>
            )}
          </Card>

          <footer className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              {t("web.bookingLanding.instantConfirmation")}
            </span>
            {stripeReady && (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                {t("web.bookingLanding.securePaymentStripe")}
              </span>
            )}
            {transferReady && (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                {t("web.bookingLanding.transferWise")}
              </span>
            )}
          </footer>
        </div>
      </div>

      {/* What the student gets for their money. Sits BELOW the packages card
          by design: the purchase path leads, reassurance follows. Moving this
          above the grid would push the buy button down the page on mobile,
          which is the classic way a "richer" landing page converts worse. */}
      <WhatsIncluded
        slug={slug}
        teacherName={teacher.name}
        liveCaptions={captionsAvailable}
        progressSharing={teacher.shareProgressByDefault}
      />

      {/* Social proof — only rendered when the teacher has published any. */}
      {teacher.testimonials.length > 0 && (
        <section className="mt-12 space-y-5">
          <Heading level={2} className="text-center">
            {t("web.bookingLanding.whatStudentsSay")}
          </Heading>
          {/* Shown only when there is a badge on the page to explain. A reader
              cannot weigh a mark whose meaning they have to guess, and a page
              with no verified quotes has nothing to say here. */}
          {teacher.testimonials.some((x) => x.source === "student_submitted") && (
            <p className="text-muted-foreground mx-auto max-w-2xl text-center text-xs">
              {t("web.bookingLanding.verifiedExplainer", { name: teacher.name })}
            </p>
          )}
          <ul className="grid gap-4 lg:grid-cols-2">
            {teacher.testimonials.map((testimonial) => {
              const tPhotoUrl = testimonialPhotoPublicUrl(testimonial.photoPath);
              // The badge is shown for what the database can prove and nothing
              // more: this person holds a student account with her, and has
              // sat in this many finished classes. No rating, no aggregate, no
              // claim about whether the opinion was unprompted — she can still
              // ask a happy student to write one, and that is fine, because
              // the badge never said otherwise.
              const verified = testimonial.source === "student_submitted";
              const classes = testimonial.studentId
                ? (classCounts.get(testimonial.studentId) ?? 0)
                : 0;
              return (
                <li key={testimonial.id}>
                  <Card className="h-full">
                    <CardContent className="space-y-3 pt-6">
                      <Quote className="text-primary/60 h-5 w-5" aria-hidden />
                      <TestimonialBody
                        body={testimonial.body}
                        moreLabel={t("web.bookingLanding.testimonialMore")}
                        lessLabel={t("web.bookingLanding.testimonialLess")}
                      />
                      <div className="flex items-center gap-2">
                        {tPhotoUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={tPhotoUrl}
                            alt={testimonial.authorName}
                            width={32}
                            height={32}
                            className="h-8 w-8 shrink-0 rounded-full object-cover"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {testimonial.authorName}
                            {testimonial.authorNote?.trim() && (
                              <span className="text-muted-foreground font-normal">
                                {" · "}
                                {testimonial.authorNote}
                              </span>
                            )}
                          </p>
                          {verified && (
                            <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                              <ShieldCheck
                                className="text-primary h-3.5 w-3.5 shrink-0"
                                aria-hidden
                              />
                              <span>
                                {t("web.bookingLanding.verifiedStudent")}
                                {classes > 0 && (
                                  <>
                                    {" · "}
                                    {t("web.bookingLanding.verifiedClasses", {
                                      count: classes,
                                      name: teacher.name,
                                    })}
                                  </>
                                )}
                              </span>
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Lead capture — for visitors who aren't ready to buy yet. scroll-mt
          keeps the card's heading clear of the viewport edge for anything that
          jumps to #contact. */}
      <section id="contact" className="mx-auto mt-12 max-w-md scroll-mt-8">
        <Card>
          <CardHeader className="text-center">
            <CardTitle as="h2" className="text-xl">
              {t("web.bookingLanding.notReadyTitle")}
            </CardTitle>
            <CardDescription>{t("web.bookingLanding.notReadyBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {teacher.publicWhatsappE164 && (
              <>
                <WhatsAppChatButton
                  whatsappE164={teacher.publicWhatsappE164}
                  teacherName={teacher.name}
                  teacherId={teacher.id}
                  slug={slug}
                  message={t("web.bookingLanding.whatsappPrefilledMessage", {
                    name: teacher.name,
                  })}
                  label={t("web.bookingLanding.whatsappButton")}
                />
                <div className="text-muted-foreground flex items-center gap-3 text-xs">
                  <span className="bg-border h-px flex-1" />
                  {t("web.bookingLanding.orWriteToUs")}
                  <span className="bg-border h-px flex-1" />
                </div>
              </>
            )}
            <LeadForm slug={slug} defaultCountry={leadPhoneCountry} />
          </CardContent>
        </Card>
      </section>

      {/* The page's ONLY link back to the platform, and deliberately the size
          it is. Two jobs: tell a student who is about to pay that the checkout
          belongs to a real product, and give the teacher-to-teacher motion in
          docs/features/student-acquisition.md a door — a peer who sees this link
          shared in a Facebook group is how the ambassador loop starts. It stays
          a footer line rather than a band because the moment SpiralClass
          competes for attention with the teacher, her page reads as a
          marketplace listing (D-24). */}
      <footer className="text-muted-foreground mt-12 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t pt-6 text-xs">
        <Link href="/" className="hover:text-foreground underline-offset-4 hover:underline">
          {t("web.bookingLanding.poweredBy")}
        </Link>
        {/* Straight to sign-up rather than to "/" again: a teacher who reads
            this line has already been sold the idea by the page she is looking
            at. Not UTM-tagged — the attribution cookie is first-touch only
            (lib/auth/middleware.ts), so a visitor who reached this page already
            has one and a tag here would record nothing. */}
        <Link href="/sign-up" className="hover:text-foreground underline-offset-4 hover:underline">
          {t("web.bookingLanding.teacherPrompt")}
        </Link>
      </footer>
    </main>
  );
}
