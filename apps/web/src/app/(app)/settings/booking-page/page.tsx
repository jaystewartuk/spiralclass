import { requireTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";
import { serverEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { loadIntroVideoAnalysisState } from "@/lib/intro-video/analysis";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HeadlineForm } from "./headline-form";
import { BioForm } from "./bio-form";
import { PhotoForm } from "./photo-form";
import { IntroVideoForm } from "./intro-video-form";
import { IntroVideoTranscriptForm } from "./intro-video-transcript-form";
import { BookingSlugForm } from "./booking-slug-form";
import { WhatsAppForm } from "./whatsapp-form";
import { ProgressSharingForm } from "./progress-sharing-form";
import { TargetLanguageForm } from "./target-language-form";
import { TeachingLanguageForm } from "./teaching-language-form";
import { BookingPageLocaleForm } from "./booking-page-locale-form";
import { BookingPageStatus } from "./booking-page-status";
import { BookingPagePreview } from "./page-preview";
import { BookingPageDraftProvider } from "./preview-context";
import { SectionNav, type SectionNavItem } from "./section-nav";
import { INSTRUMENT_READINESS_SELECT } from "@/lib/marketplace-ready";
import { bookingPageReadiness } from "@/lib/booking/page-readiness";
import { publicFunnelLocaleFor } from "@spiralclass/shared";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { introVideoStorageConfigured, teacherVideoPublicUrl } from "@/lib/storage/teacher-video";

// Settings → Booking page. The public-facing content shown on /b/<slug>.
// Split out from the account page because it edits the PUBLIC page rather than
// the account; the account page holds only account-level concerns.
//
// ## The shape of this screen, and why it changed
//
// It was eight `Card`s of equal weight in a flat stack. Three problems, all
// fixed here:
//
//  1. **It never said whether the page worked.** `/b/<slug>` calls
//     `notFound()` unless `isPubliclyListed()` passes, so a teacher with no
//     photo has a link that 404s for every student she sends it to — and this
//     screen rendered identically either way, displaying the dead link as if it
//     were live. `BookingPageStatus` now leads with that answer and names the
//     specific thing holding the page down. This is the single biggest change.
//  2. **It never showed the page.** An editor for a public page that never
//     renders it makes every field a guess. `BookingPagePreview` sits beside
//     the fields that feed it and updates as she types.
//  3. **No hierarchy and no grouping.** Every card title rendered at 22px —
//     exactly the size of the page's own `<h1>` — so nothing led. Titles now
//     step down to 19px, and the eight cards are six sections ordered by what a
//     student meets first, with the rarely-touched slug editor moved off the
//     top spot it did not earn.
export default async function BookingPageSettings() {
  const teacher = await requireTeacher();
  const t = await getT();
  const appUrl = serverEnv().APP_URL;
  const introVideoLive = introVideoStorageConfigured();

  // AI coach feedback + pipeline status on the intro video (D-73, Layer 3),
  // if it's been generated (Pro teachers only; async after upload).
  // Teacher-only — shown in the editor.
  const [introVideoAnalysis, payoutInstruments, cheapestPackage] = await Promise.all([
    introVideoLive
      ? loadIntroVideoAnalysisState(teacher.id)
      : Promise.resolve({ status: null, coach: null, error: null, hasTranscript: false }),
    // Readiness needs the payout rail, which is a relation `requireTeacher()`
    // does not carry.
    prisma.teacherPayoutInstrument.findMany({
      where: { teacherId: teacher.id },
      select: INSTRUMENT_READINESS_SELECT,
    }),
    // The hero quotes the cheapest live package in its price/duration badges,
    // so the preview needs the same row the public page picks.
    prisma.packageTemplate.findFirst({
      where: { teacherId: teacher.id, archived: false },
      orderBy: { priceMinorUnits: "asc" },
      select: {
        priceMinorUnits: true,
        currency: true,
        classCount: true,
        classDurationMin: true,
        singleClass: true,
      },
    }),
  ]);

  const readiness = bookingPageReadiness({
    disabledAt: teacher.disabledAt,
    onboardingCompleteAt: teacher.onboardingCompleteAt,
    photoPath: teacher.photoPath,
    bio: teacher.bio,
    templatesTouchedAt: teacher.templatesTouchedAt,
    availabilityTouchedAt: teacher.availabilityTouchedAt,
    stripeChargesEnabled: teacher.stripeChargesEnabled,
    pricingCurrency: teacher.pricingCurrency,
    payoutInstruments,
    headline: teacher.headline,
    introVideoPath: teacher.introVideoPath,
    targetLanguage: teacher.targetLanguage,
    publicWhatsappE164: teacher.publicWhatsappE164,
    introVideoAvailable: introVideoLive,
  });

  const base = appUrl.replace(/\/$/, "");
  const fullUrl = `${base}/b/${teacher.bookingSlug}`;
  const displayUrl = `${base.replace(/^https?:\/\//, "")}/b/${teacher.bookingSlug}`;
  const photoUrl = teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime());

  // Only the sections this deploy actually renders — a jump link to a card that
  // is feature-gated off would scroll to nothing.
  const sections: SectionNavItem[] = [
    { id: "profile", label: t("web.settings.bookingPage.nav.profile") },
    ...(introVideoLive ? [{ id: "video", label: t("bookingPage.introVideo") }] : []),
    { id: "languages", label: t("web.settings.bookingPage.teachingTitle") },
    { id: "contact", label: t("web.settings.bookingPage.nav.contact") },
    { id: "link", label: t("bookingLink.title") },
    { id: "students", label: t("web.settings.bookingPage.progressSharingTitle") },
  ];

  return (
    // Headline and bio are typed behind a Save button, so the preview reads them
    // from here rather than from the server round-trip that has not happened yet.
    <BookingPageDraftProvider initialHeadline={teacher.headline} initialBio={teacher.bio}>
      <div className="space-y-6">
        <PageHeader
          title={t("bookingPage.title")}
          description={t("web.settings.bookingPage.intro")}
        />

        <BookingPageStatus readiness={readiness} fullUrl={fullUrl} displayUrl={displayUrl} />

        <SectionNav label={t("web.settings.bookingPage.nav.label")} items={sections} />

        {/* 1 — Profile. The face of the page: photo, headline, bio, previewed
            beside the fields that produce them. */}
        <Card id="profile" className="scroll-mt-20">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {t("web.settings.bookingPage.profileTitle")}
            </CardTitle>
            <CardDescription>{t("web.settings.bookingPage.profileHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* 3:2 rather than 1:1. At the settings column's 768px an even
                split leaves the form about 350px wide, which wraps "0 / 80"
                onto two lines and squeezes the photo row; the preview is a
                phone rendering and reads correctly at the narrower share. */}
            <div className="grid gap-6 lg:grid-cols-5 lg:gap-8">
              <div className="space-y-6 lg:col-span-3">
                <PhotoForm photoUrl={photoUrl} name={teacher.name} />
                <div className="border-t pt-6">
                  <HeadlineForm initialHeadline={teacher.headline} />
                </div>
                <div className="border-t pt-6">
                  <BioForm initialBio={teacher.bio} />
                </div>
              </div>

              {/* Second in the DOM, which is also where a phone wants it: the
                  repeat visit here is an errand — "change my headline" — and a
                  full screen of preview before the first field taxes every one
                  of them. From `lg` up the grid puts it alongside instead,
                  where it sticks while the fields scroll. That includes the
                  1280px landscape tablet teachers work from. */}
              <div className="lg:col-span-2">
                <div className="space-y-2 lg:sticky lg:top-20">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("web.settings.bookingPage.preview.title")}
                  </p>
                  <BookingPagePreview
                    name={teacher.name}
                    photoUrl={photoUrl}
                    initialHeadline={teacher.headline}
                    initialBio={teacher.bio}
                    timezone={teacher.timezone}
                    offering={cheapestPackage}
                    hasVideo={Boolean(teacher.introVideoPath)}
                    hasWhatsapp={Boolean(teacher.publicWhatsappE164)}
                    funnelLocale={publicFunnelLocaleFor(teacher.bookingPageLocale)}
                    displayUrl={displayUrl}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2 — Intro video. Storage-gated. */}
        {introVideoLive && (
          <Card id="video" className="scroll-mt-20">
            <CardHeader>
              <CardTitle as="h2" className="text-lg">
                {t("bookingPage.introVideo")}
              </CardTitle>
              <CardDescription>{t("web.settings.bookingPage.videoCardHelp")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <IntroVideoForm
                videoUrl={teacherVideoPublicUrl(
                  teacher.introVideoPath,
                  teacher.updatedAt.getTime(),
                )}
                analysis={introVideoAnalysis}
              />
              {/* Only shown once a transcript actually exists — a Pro-only fact,
                  since only the Pro coach pipeline (D-73) generates one. */}
              {introVideoAnalysis.hasTranscript && (
                <div className="border-t pt-6">
                  <IntroVideoTranscriptForm
                    initialOptedIn={teacher.introVideoTranscriptPublicOptIn}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 3 — Languages. Three separate questions that are constantly confused
            for each other (D-72/D-73, and the booking_page_locale amendment), so
            they are configured together with their differences visible side by
            side rather than scattered. */}
        <Card id="languages" className="scroll-mt-20">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {t("web.settings.bookingPage.teachingTitle")}
            </CardTitle>
            <CardDescription>{t("web.settings.bookingPage.teachingHelp")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <TargetLanguageForm initialTargetLanguage={teacher.targetLanguage} />
            <div className="border-t pt-6">
              <TeachingLanguageForm initialLanguage={teacher.teachingLanguage} />
            </div>
            {/* The third question, and the one about her BUYERS rather than her
                teaching. */}
            <div className="border-t pt-6">
              <BookingPageLocaleForm initialLocale={teacher.bookingPageLocale} />
            </div>
          </CardContent>
        </Card>

        {/* 4 — How a student reaches her before booking. WhatsApp and quick
            chats answer the same question and used to sit in separate cards
            with three unrelated ones between them. */}
        <Card id="contact" className="scroll-mt-20">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {t("web.settings.bookingPage.nav.contact")}
            </CardTitle>
            <CardDescription>{t("web.settings.bookingPage.contactHelp")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">
                  {t("web.settings.bookingPage.whatsappTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("web.settings.bookingPage.whatsappCardHelp")}
                </p>
              </div>
              <WhatsAppForm
                initialWhatsapp={teacher.publicWhatsappE164}
                initialCountry={teacher.country}
              />
            </div>
          </CardContent>
        </Card>

        {/* 5 — The link. Deliberately low: it is set once, changing it breaks
            every link already shared, and the status card at the top already
            shows and copies it. */}
        <Card id="link" className="scroll-mt-20">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {t("bookingLink.title")}
            </CardTitle>
            <CardDescription>{t("bookingLink.help")}</CardDescription>
          </CardHeader>
          <CardContent>
            <BookingSlugForm
              initialSlug={teacher.bookingSlug}
              appUrl={appUrl}
              showFullLink={false}
            />
          </CardContent>
        </Card>

        {/* 6 — After they book. Ungated: sharing a student's own progress with
            her needs no platform flag and no vendor. */}
        <Card id="students" className="scroll-mt-20">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {t("web.settings.bookingPage.progressSharingTitle")}
            </CardTitle>
            <CardDescription>{t("web.settings.bookingPage.progressSharingHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProgressSharingForm initialShared={teacher.shareProgressByDefault} />
          </CardContent>
        </Card>
      </div>
    </BookingPageDraftProvider>
  );
}
