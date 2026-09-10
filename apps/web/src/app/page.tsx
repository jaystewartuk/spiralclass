import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRing,
  CalendarClock,
  Check,
  Clapperboard,
  Globe,
  Languages,
  Link2,
  Repeat,
  Sparkles,
  Video,
  Wallet,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { JsonLd } from "@/components/json-ld";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { Section } from "@/components/marketing/section";
import { FeatureCard } from "@/components/marketing/feature-card";
import { CtaBand } from "@/components/marketing/cta-band";
import { CaptionsDemo } from "@/components/marketing/captions-demo";
import { getT } from "@/lib/i18n";
import { isSuperuser } from "@/lib/env";
import { getAuthUser, getCurrentTeacher } from "@/lib/auth";
import { hasClaimableStudentRow } from "@/lib/auth/student-link";
import { TRIAL_DAYS } from "@/lib/subscriptions/config";
import {
  organizationJsonLd,
  seoBaseUrl,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from "@/lib/seo/jsonld";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    // Absolute: the home page gets the descriptive tagline title, not the
    // bare brand default from the layout template.
    title: { absolute: t("web.landing.meta.title") },
    description: t("web.landing.meta.description", { days: TRIAL_DAYS }),
    alternates: { canonical: "/" },
  };
}

// Auth guards bounce people here with a reason code rather than dumping them on
// an unexplained marketing page. `requireStudent` sends `no-student-record`
// (signed in, but no Student row this identity can claim) and `requireTeacher`
// sends `teacher-disabled`. Both were already being redirected before this —
// the page just never read the param, so a customer who had *just paid* landed
// on a sales page with no explanation of why her classes weren't there.
//
// Allowlisted rather than rendered from the raw param: this value arrives in a
// URL anyone can craft, so it must never reach the page as text.
const AUTH_NOTICES = {
  "no-student-record": "web.landing.authNotice.noStudentRecord",
  "teacher-disabled": "web.landing.authNotice.teacherDisabled",
} as const;

export default async function LandingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getT();

  const params = searchParams ? await searchParams : {};
  const errorParam = typeof params.error === "string" ? params.error : null;
  const authNoticeKey =
    errorParam && errorParam in AUTH_NOTICES
      ? AUTH_NOTICES[errorParam as keyof typeof AUTH_NOTICES]
      : null;

  // Core value props — the everyday "runs your business" capabilities.
  const valueProps = [
    {
      icon: Link2,
      title: t("web.landing.feature.book.title"),
      body: t("web.landing.feature.book.body"),
    },
    {
      icon: Wallet,
      title: t("web.landing.feature.pay.title"),
      body: t("web.landing.feature.pay.body"),
    },
    {
      icon: BellRing,
      title: t("web.landing.feature.reminders.title"),
      body: t("web.landing.feature.reminders.body"),
    },
    {
      icon: Video,
      title: t("web.landing.feature.video.title"),
      body: t("web.landing.feature.video.body"),
    },
    {
      icon: CalendarClock,
      title: t("web.landing.feature.calendar.title"),
      body: t("web.landing.feature.calendar.body"),
    },
    {
      icon: Globe,
      title: t("web.landing.feature.globalPay.title"),
      body: t("web.landing.feature.globalPay.body"),
    },
  ];

  // The live-lesson AI stack — the differentiators a marketplace can't match.
  //
  // Every card here must name something a visitor who signs up today can
  // actually reach; `tests/config/ai-marketing-claims.test.ts` holds each claim
  // against the enablement flag that governs it in
  // `config/env/production.runtime.env`, and fails if a card outruns its flag.
  //
  // Three cards were removed rather than reworded, each because its capability
  // is off in production. Re-add one in the SAME change that turns its flag on,
  // not before:
  //   Pronunciation scoring — LESSON_INSIGHTS_PRONUNCIATION_ENABLED, never on
  //     in any environment, so no student has ever seen a phoneme score.
  //   AI lesson insights — LESSON_INSIGHTS_TRANSCRIPTION_ENABLED, turned off
  //     again by D-114 ahead of first promotion.
  //   Study podcasts — MATERIAL_PODCASTS_ENABLED, the flag D-114 added so the
  //     feature has an off switch that isn't "pull a secret".
  const aiFeatures = [
    {
      icon: Languages,
      title: t("web.landing.ai.captions.title"),
      body: t("web.landing.ai.captions.body"),
    },
    { icon: Repeat, title: t("web.landing.ai.srs.title"), body: t("web.landing.ai.srs.body") },
    {
      // Intro-video AI coach (D-73): INTRO_VIDEO_COACH_ENABLED is on in
      // production. Pro-gated at the pipeline, but every new teacher starts on
      // the 30-day Pro trial, so a visitor signing up today can reach it. The
      // flag alone doesn't prove DEEPGRAM_API_KEY is set (Infisical, not this
      // repo — the guard test's scope note): verify with `fly secrets list
      // --app agendaprofe`, don't assume.
      icon: Clapperboard,
      title: t("web.landing.ai.videoCoach.title"),
      body: t("web.landing.ai.videoCoach.body"),
    },
  ];

  const steps = [
    t("web.landing.steps.createAccount"),
    t("web.landing.steps.share"),
    t("web.landing.steps.teach"),
  ];

  // The founding-cohort claim is gone. The strategy was discarded, so the page
  // was advertising a programme nobody could join — the worst kind of stale
  // marketing, because it reads as current. Two true pills beat three with one
  // that is not.
  const trustPills = [t("web.landing.trust.keepAll"), t("web.landing.trust.aiLessons")];

  const socialStats = [
    {
      value: t("web.landing.social.stat.rails.value"),
      label: t("web.landing.social.stat.rails.label"),
    },
    { value: t("web.landing.social.stat.ai.value"), label: t("web.landing.social.stat.ai.label") },
  ];

  // Auth-aware hero CTA: a logged-in visitor landing here should be offered a
  // direct way into their own area (like Supabase's "Dashboard" nav link)
  // rather than the sign-in / create-account prompts that no longer apply.
  // We keep the marketing page rather than force-redirecting so they can still
  // read it. Destination is resolved by role to match the auth middleware.
  const user = await getAuthUser();
  let loggedInCta: { href: string; label: string } | null = null;
  // Superusers see the admin shortcut in the hero, but the closing marketing
  // band ("start teaching…") is a prospect-conversion pitch that's meaningless
  // for an ops admin, so we suppress it for them rather than show a "go to
  // admin" button under a "start teaching" heading.
  let isAdmin = false;
  if (user) {
    if (isSuperuser(user.email)) {
      isAdmin = true;
      loggedInCta = { href: "/admin", label: t("web.landing.goToAdmin") };
    } else {
      // `hasClaimableStudentRow`, not getCurrentStudent(): the latter matches on
      // `authUserId`, which is null for a student whose first-ever sign-in is
      // the magic link from her own purchase. She therefore fell into the else
      // branch below and was handed the teacher dashboard — which then
      // provisioned her as a teacher. Ask whether a Student row is claimable
      // by this identity, which is the same question requireStudent answers.
      const [teacher, student] = await Promise.all([
        getCurrentTeacher(),
        hasClaimableStudentRow({ id: user.id, email: user.email }),
      ]);
      if (student && !teacher) {
        loggedInCta = { href: "/my-classes", label: t("landing.studentCta") };
      } else {
        // Teacher, or an authed user with no role row of either kind — the
        // dashboard guard provisions a teacher on first visit, and now refuses
        // to do so when a Student row is claimable.
        loggedInCta = { href: "/dashboard", label: t("web.landing.goToDashboard") };
      }
    }
  }

  const baseUrl = seoBaseUrl();
  const featureList = [...valueProps, ...aiFeatures].map((f) => f.title);

  return (
    <main className="flex flex-col">
      <JsonLd data={organizationJsonLd(baseUrl)} />
      <JsonLd data={webSiteJsonLd(baseUrl)} />
      <JsonLd data={softwareApplicationJsonLd(baseUrl, featureList)} />

      <MarketingHeader loggedInCta={loggedInCta} />

      {authNoticeKey && (
        <div className="container pt-6">
          <Alert variant="warning" role="status">
            <AlertDescription>{t(authNoticeKey)}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Hero — warm atmosphere behind a serif headline */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {/* One ink wash behind the mark, and a small gold one offset from it.
              The gold was at 20% and read as a stain on a cool ground — the
              accent is a highlight, not a wash. */}
          <div className="bg-primary/10 absolute top-[-12%] left-1/2 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full blur-3xl" />
          <div className="bg-accent/10 absolute top-[26%] right-[6%] h-56 w-56 rounded-full blur-3xl" />
        </div>

        <div className="container flex flex-col items-center gap-6 py-20 text-center lg:py-28">
          <Logo size="xl" />

          <span className="border-border/70 bg-card/60 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-medium backdrop-blur">
            <Sparkles className="text-accent h-3.5 w-3.5" aria-hidden />
            {t("web.landing.eyebrow")}
          </span>

          <Heading level={1} className="max-w-reading lg:text-display text-balance">
            {t("web.landing.headline")}
          </Heading>

          <p className="max-w-reading text-muted-foreground text-lg text-pretty">
            {t("web.landing.sub")}
          </p>

          <div className="mt-2 flex w-full flex-col items-center gap-3 lg:w-auto lg:flex-row">
            {loggedInCta ? (
              <Button asChild size="lg" className="w-full lg:w-auto">
                <Link href={loggedInCta.href}>{loggedInCta.label}</Link>
              </Button>
            ) : (
              <>
                <Button asChild size="lg" className="w-full lg:w-auto">
                  <Link href="/sign-up">{t("web.landing.cta")}</Link>
                </Button>
                <Button asChild size="lg" variant="outline" className="w-full lg:w-auto">
                  <Link href="/sign-in">{t("web.signIn.title")}</Link>
                </Button>
              </>
            )}
          </div>

          <ul className="text-muted-foreground mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs">
            {trustPills.map((pill) => (
              <li key={pill} className="inline-flex items-center gap-1.5">
                <Check className="text-primary h-3.5 w-3.5" aria-hidden />
                {pill}
              </li>
            ))}
          </ul>

          {!loggedInCta && (
            <p className="text-muted-foreground text-sm">
              {t("landing.studentPrompt")}{" "}
              <Link
                href="/sign-in"
                className="text-foreground font-medium underline-offset-4 hover:underline"
              >
                {t("landing.studentCta")}
              </Link>
            </p>
          )}
        </div>
      </section>

      {/* The wedge — teachers keep ~100%, and we're a tool, not a marketplace */}
      <Section
        variant="band"
        eyebrow={t("web.landing.wedge.eyebrow")}
        title={t("web.landing.wedge.title")}
        description={t("web.landing.wedge.sub")}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="bg-card/50 rounded-2xl border p-6 text-center">
            <p className="text-muted-foreground text-sm font-medium">
              {t("web.landing.wedge.marketplace.label")}
            </p>
            <p className="font-display text-muted-foreground mt-2 text-2xl font-semibold">
              {t("web.landing.wedge.marketplace.value")}
            </p>
          </div>
          <div className="border-primary bg-card rounded-2xl border-2 p-6 text-center shadow-xs">
            <p className="text-primary text-sm font-medium">{t("web.landing.wedge.us.label")}</p>
            <p className="font-display mt-2 text-2xl font-semibold">
              {t("web.landing.wedge.us.value")}
            </p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              {t("web.landing.wedge.us.note")}
            </p>
          </div>
        </div>
      </Section>

      {/* Live-lesson AI showcase — the demo is the centerpiece */}
      <Section
        width="wide"
        eyebrow={t("web.landing.ai.eyebrow")}
        title={t("web.landing.ai.title")}
        description={t("web.landing.ai.sub")}
      >
        <CaptionsDemo
          badge={t("web.landing.demo.badge")}
          speakerLabel={t("web.landing.demo.speakerLabel")}
          translationLabel={t("web.landing.demo.translationLabel")}
          replayLabel={t("web.landing.demo.replay")}
          a11yLabel={t("web.landing.demo.a11yLabel")}
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {aiFeatures.map((feature) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              title={feature.title}
              body={feature.body}
            />
          ))}
        </div>
      </Section>

      {/* Everyday value props */}
      <Section width="wide" title={t("web.landing.featuresTitle")}>
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {valueProps.map((feature) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              title={feature.title}
              body={feature.body}
            />
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link
            href="/features"
            className="text-primary text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("web.landing.seeAllFeatures")}
          </Link>
        </div>
      </Section>

      {/* How it works — quiet warm band */}
      <Section variant="band" title={t("web.landing.stepsTitle")}>
        <ol className="grid gap-8 lg:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step} className="text-center lg:text-left">
              <span className="font-display text-primary/40 text-3xl font-semibold tabular-nums">
                {`0${i + 1}`}
              </span>
              <p className="text-foreground/80 mt-2 text-sm leading-relaxed">{step}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* Honest social proof — capability stats only, no fake reviews and no
          offer nobody can take up */}
      <Section title={t("web.landing.social.title")} description={t("web.landing.social.body")}>
        <dl className="grid gap-6 lg:grid-cols-3">
          {socialStats.map((stat) => (
            <div key={stat.value} className="bg-card rounded-2xl border p-6 text-center shadow-xs">
              <dt className="font-display text-primary text-2xl font-semibold">{stat.value}</dt>
              <dd className="text-muted-foreground mt-1 text-sm">{stat.label}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* Closing CTA — prospect-conversion band; hidden for superadmins, for
          whom a "start teaching" pitch is irrelevant. */}
      {!isAdmin && (
        <CtaBand
          title={t("web.landing.ctaBandTitle")}
          primaryHref={loggedInCta ? loggedInCta.href : "/sign-up"}
          primaryLabel={loggedInCta ? loggedInCta.label : t("web.landing.cta")}
          secondaryHref={loggedInCta ? undefined : "/pricing"}
          secondaryLabel={loggedInCta ? undefined : t("web.landing.seePricing")}
        />
      )}
    </main>
  );
}
