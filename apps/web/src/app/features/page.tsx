import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import Link from "next/link";
import type { Metadata } from "next";
import {
  BellRing,
  BookOpen,
  CalendarCheck,
  CalendarClock,
  Captions,
  Clapperboard,
  CreditCard,
  FileText,
  Globe,
  Link2,
  MessageSquare,
  Repeat,
  Smartphone,
  Users,
  Video,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeatureCard } from "@/components/marketing/feature-card";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("web.features.meta.title"),
    description: t("web.features.meta.description"),
    alternates: { canonical: "/features" },
  };
}

export default async function FeaturesPage() {
  const t = await getT();

  const FEATURE_ITEMS = [
    {
      icon: Link2,
      title: t("web.features.item.booking.title"),
      body: t("web.features.item.booking.body"),
    },
    {
      icon: CalendarCheck,
      title: t("web.features.item.calendar.title"),
      body: t("web.features.item.calendar.body"),
    },
    {
      icon: Wallet,
      title: t("web.features.item.getPaid.title"),
      body: t("web.features.item.getPaid.body"),
    },
    {
      icon: Globe,
      title: t("web.features.item.globalPay.title"),
      body: t("web.features.item.globalPay.body"),
    },
    {
      icon: BellRing,
      title: t("web.features.item.reminders.title"),
      body: t("web.features.item.reminders.body"),
    },
    {
      icon: Video,
      title: t("web.features.item.videoLessons.title"),
      body: t("web.features.item.videoLessons.body"),
    },
    {
      icon: Captions,
      title: t("web.features.item.liveCaptions.title"),
      body: t("web.features.item.liveCaptions.body"),
    },
    // The intro-video AI coach (INTRO_VIDEO_COACH_ENABLED) is on in
    // production; the marketing-claims guard holds this card against that flag.
    {
      icon: Clapperboard,
      title: t("web.features.item.videoCoach.title"),
      body: t("web.features.item.videoCoach.body"),
    },
    // Three AI items are deliberately absent — pronunciation scoring, AI lesson
    // insights, and study podcasts — each because its enablement flag is off in
    // production. See the note on the landing page's aiFeatures array and
    // tests/config/ai-marketing-claims.test.ts, which fails if one is re-added
    // without its flag being turned on in the same change.
    {
      icon: Repeat,
      title: t("web.features.item.srs.title"),
      body: t("web.features.item.srs.body"),
    },
    {
      icon: CalendarClock,
      title: t("web.features.item.calendarSync.title"),
      body: t("web.features.item.calendarSync.body"),
    },
    {
      icon: MessageSquare,
      title: t("web.features.item.chat.title"),
      body: t("web.features.item.chat.body"),
    },
    {
      icon: FileText,
      title: t("web.features.item.materials.title"),
      body: t("web.features.item.materials.body"),
    },
    {
      icon: BookOpen,
      title: t("web.features.item.library.title"),
      body: t("web.features.item.library.body"),
    },
    {
      icon: Users,
      title: t("web.features.item.notes.title"),
      body: t("web.features.item.notes.body"),
    },
    {
      icon: CreditCard,
      title: t("web.features.item.pricing.title"),
      body: t("web.features.item.pricing.body"),
    },
    {
      icon: Smartphone,
      title: t("web.features.item.homeScreen.title"),
      body: t("web.features.item.homeScreen.body"),
    },
  ];

  return (
    <PageShell width="wide">
      <header className="text-center">
        <Heading level={1} className="lg:text-display">
          {t("web.features.headline")}
        </Heading>
        <p className="mx-auto mt-4 max-w-reading text-pretty text-lg text-muted-foreground">
          {t("web.features.sub")}
        </p>
      </header>

      <div className="mt-12 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
        {FEATURE_ITEMS.map((f) => (
          <FeatureCard key={f.title} icon={f.icon} title={f.title} body={f.body} titleAs="h2" />
        ))}
      </div>

      <div className="mt-14 rounded-3xl bg-primary px-6 py-14 text-center text-primary-foreground">
        <Heading level={2}>{t("web.trialBand.title")}</Heading>
        <p className="mt-3 text-primary-foreground">{t("web.trialBand.noCard")}</p>
        <div className="mt-7 flex flex-col items-center gap-3 lg:flex-row lg:justify-center">
          <Button asChild size="lg" variant="secondary">
            <Link href="/sign-up">{t("web.trialBand.createAccount")}</Link>
          </Button>
          <Button asChild size="lg" variant="outlineOnPrimary">
            <Link href="/pricing">{t("web.features.seePricing")}</Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
