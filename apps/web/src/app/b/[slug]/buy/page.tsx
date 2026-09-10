import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { currencyForTeacher } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { approxUsdAssumptions, approxUsdFrom } from "@/lib/pricing/approx-usd";
import { listOfferableInstruments } from "@/lib/payments/instruments";
import { PurchaseFlow } from "./purchase-flow";
import { INSTRUMENT_READINESS_SELECT, isPubliclyListed } from "@/lib/marketplace-ready";
import { loadSlotInputs } from "@/lib/booking/slot-inputs";
import { getPublicFunnelT } from "@/lib/i18n";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";

// Checkout is thin per-teacher duplicate content — keep the funnel out of the
// index (the indexable page is the booking landing at /b/[slug]).
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default async function PurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ package?: string; ref?: string }>;
}) {
  const { slug } = await params;
  const { package: requestedPackageId, ref: refCode } = await searchParams;

  // The public booking page is the NEW-student acquisition funnel — every buyer
  // types their own email (the identity + magic-link address). We deliberately
  // do NOT pre-fill from a signed-in session: a signed-in student repurchases
  // in-app (my-classes/buy, which has no email field), so on this page a session
  // is not a reliable signal of who's buying — pre-filling it silently attached
  // purchases to the wrong student when the session was stale. The URL discount
  // code (prefillCode) is still honoured; it's a shareable link param, not
  // session-derived.
  const teacher = await prisma.teacher.findUnique({
    where: { bookingSlug: slug },
    select: {
      id: true,
      name: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      timezone: true,
      bufferMin: true,
      minAdvanceH: true,
      maxAdvanceDays: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
      pricingCurrency: true,
      payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
      photoPath: true,
      bio: true,
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      // ONE published quote, for the checkout's reassurance strip. The landing
      // page renders the full list; this is deliberately a single row (the
      // teacher's own first-ranked one) because checkout is not the place to
      // start reading. Same published/order rules as the landing page so the
      // two can never disagree about which quote is the lead.
      testimonials: {
        where: { published: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { body: true, authorName: true, authorNote: true },
        take: 1,
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
          transferPriceMinorUnits: true,
          expirationMonths: true,
          currency: true,
        },
      },
    },
  });

  // Same visibility rule as the booking landing (isPubliclyListed, onboarding
  // activation audit): a disabled OR not-yet-Marketplace-Ready
  // teacher's checkout must 404, not keep selling from a stale shared link.
  if (!teacher || !isPubliclyListed(teacher)) notFound();

  const funnelLocale = await funnelLocaleForSlug(slug);
  const t = getPublicFunnelT(funnelLocale);
  // Terms link follows the funnel's own language, not the browser's — sending
  // an English checkout's cancellation-policy link to the Spanish terms is
  // exactly the split this pinning exists to remove.
  const termsHref = "/terms?lang=en#cancelaciones";
  const teacherName = teacher.name.trim();

  const stripeReady = Boolean(teacher.stripeAccountId && teacher.stripeChargesEnabled);
  // Filtered here rather than in the client component: offerability depends on
  // the teacher's pricing currency, and the credential columns must never be
  // serialized into the RSC payload (INSTRUMENT_SELECT omits them).
  const instruments = await listOfferableInstruments(
    prisma,
    teacher.id,
    currencyForTeacher(teacher),
  );

  // Preload the availability window so the slot picker can render client-side
  // (the student picks a time before paying). Since D-111 this is needed for
  // every offering, not just individual classes — a package offers its FIRST
  // class here — so it's loaded whenever the teacher has anything to sell, and
  // skipped only when she has nothing (the empty state below renders no flow).
  const hasTemplates = teacher.packageTemplates.length > 0;
  const slotTeacher = hasTemplates
    ? {
        timezone: teacher.timezone,
        bufferMin: teacher.bufferMin,
        minAdvanceH: teacher.minAdvanceH,
        maxAdvanceDays: teacher.maxAdvanceDays,
      }
    : undefined;
  const now = new Date();
  const slotInputs = hasTemplates
    ? await loadSlotInputs(
        prisma,
        teacher.id,
        now,
        new Date(now.getTime() + teacher.maxAdvanceDays * 24 * 3600_000),
      )
    : undefined;

  // The same approximate-USD rule the landing page applies, so the figure a
  // buyer saw next to the package they clicked is still there when they arrive
  // to pay. Gated on the funnel locale rather than the visitor — see the longer
  // note at the landing page's call site.
  const approxAssumptions = funnelLocale === "en" ? await approxUsdAssumptions() : null;
  const templatesWithApprox = teacher.packageTemplates.map((tpl) => ({
    ...tpl,
    approxUsdCents: approxAssumptions
      ? (approxUsdFrom(tpl.priceMinorUnits, tpl.currency, approxAssumptions, now)?.centsUsd ?? null)
      : null,
  }));

  return (
    <main className="container py-8 lg:py-12">
      {/* One narrow column at every width. The two-column grid this replaced
          put the page's own <h1> below the content it titled on a phone, and
          nothing in a checkout benefits from 56rem of width — the eye wants one
          decision under the last one. */}
      <div className="mx-auto max-w-lg space-y-6">
        <Link
          href={`/b/${slug}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t("book.backToProfile", { name: teacherName })}
        </Link>

        {teacher.packageTemplates.length === 0 ? (
          <>
            <Heading level={2} as="h1" className="lg:text-3xl">
              {t("book.packagesWith", { name: teacherName })}
            </Heading>
            <p className="text-sm text-muted-foreground">{t("publicProfile.noPackages")}</p>
          </>
        ) : (
          <PurchaseFlow
            slug={slug}
            teacherName={teacherName}
            teacherPhotoUrl={teacherPhotoPublicUrl(teacher.photoPath)}
            testimonial={teacher.testimonials[0] ?? null}
            templates={templatesWithApprox}
            initialTemplateId={requestedPackageId}
            stripeReady={stripeReady}
            instruments={instruments}
            prefillCode={refCode}
            slotTeacher={slotTeacher}
            slotInputs={slotInputs}
          />
        )}

        {/* The seller-of-record (CFDI) disclaimer now renders inside
            CheckoutForm, rail-aware — it needs to know the selected payment
            method, which only exists inside <PurchaseFlow>. */}
        <footer className="space-y-2 border-t pt-4 text-xs text-muted-foreground">
          <p>
            {t("book.byPaying")}{" "}
            <Link href={termsHref} className="underline">
              {t("terms.linkLabel")}
            </Link>{" "}
            {t("book.byPayingAnd")}{" "}
            <Link href="/privacy-notice" className="underline">
              {t("web.signUp.privacyNotice")}
            </Link>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
