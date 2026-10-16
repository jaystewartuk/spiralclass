import { localizedAlternates } from "@/lib/seo/localized-alternates";
import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRing,
  BookOpen,
  CalendarClock,
  Check,
  Clapperboard,
  Globe,
  Languages,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { JsonLd } from "@/components/json-ld";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { Section } from "@/components/marketing/section";
import { FeatureCard } from "@/components/marketing/feature-card";
import { FeatureClip } from "@/components/marketing/feature-clip";
import { CtaBand } from "@/components/marketing/cta-band";
import { getLocalizedHref, getPreferredLocale, getT } from "@/lib/i18n";
import { isSuperuser } from "@/lib/env";
import { getAuthUser, getCurrentTeacher } from "@/lib/auth";
import { hasClaimableStudentRow } from "@/lib/auth/student-link";
import { TEACHER_TESTIMONIAL } from "@/lib/marketing/testimonial";
import { TRIAL_DAYS } from "@/lib/subscriptions/config";
import {
  organizationJsonLd,
  seoBaseUrl,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from "@/lib/seo/jsonld";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    // Absolute: the home page gets the descriptive tagline title, not the
    // bare brand default from the layout template.
    title: { absolute: t("web.landing.meta.title") },
    description: t("web.landing.meta.description", { days: TRIAL_DAYS }),
    alternates: localizedAlternates("/", await getPreferredLocale()),
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

const TOUR_ID = "tour";

export default async function LandingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getT();
  const href = await getLocalizedHref();

  const params = searchParams ? await searchParams : {};
  const errorParam = typeof params.error === "string" ? params.error : null;
  const authNoticeKey =
    errorParam && errorParam in AUTH_NOTICES
      ? AUTH_NOTICES[errorParam as keyof typeof AUTH_NOTICES]
      : null;

  // The tour: one job per section, each shown by a clip recorded from the
  // running app (scripts/marketing/record.mjs). The order is the order of a
  // class — before it, during it, after it — then the business around it.
  //
  // Every title here is a promise on a public page, so each key is classified
  // in tests/config/ai-marketing-claims.test.ts: the `web.landing.ai.*` ones
  // name the production flag that makes them true, the `web.landing.feature.*`
  // ones are declared flag-free. A capability that is off in production
  // (pronunciation scoring, study podcasts, class recording) has no clip and no
  // card; re-adding one means turning its flag on in the same change.
  const tour = [
    {
      clip: "call",
      title: t("web.landing.ai.captions.title"),
      body: t("web.landing.ai.captions.body"),
      label: t("web.landing.clip.call"),
    },
    {
      clip: "materials",
      title: t("web.landing.ai.lessonPlans.title"),
      body: t("web.landing.ai.lessonPlans.body"),
      label: t("web.landing.clip.materials"),
    },
    {
      clip: "learning",
      title: t("web.landing.ai.learningNotes.title"),
      body: t("web.landing.ai.learningNotes.body"),
      label: t("web.landing.clip.learning"),
    },
    {
      clip: "vocabulary",
      portrait: true,
      title: t("web.landing.ai.srs.title"),
      body: t("web.landing.ai.srs.body"),
      label: t("web.landing.clip.vocabulary"),
    },
    {
      clip: "homework",
      title: t("web.landing.ai.homework.title"),
      body: t("web.landing.ai.homework.body"),
      label: t("web.landing.clip.homework"),
    },
    {
      clip: "dashboard",
      title: t("web.landing.feature.dashboard.title"),
      body: t("web.landing.feature.dashboard.body"),
      label: t("web.landing.clip.dashboard"),
    },
    {
      clip: "messages",
      title: t("web.landing.feature.messages.title"),
      body: t("web.landing.feature.messages.body"),
      label: t("web.landing.clip.messages"),
    },
    {
      clip: "payments",
      title: t("web.landing.feature.payments.title"),
      body: t("web.landing.feature.payments.body"),
      label: t("web.landing.clip.payments"),
    },
    {
      clip: "students",
      title: t("web.landing.feature.students.title"),
      body: t("web.landing.feature.students.body"),
      label: t("web.landing.clip.students"),
    },
  ];

  // The rest of the job: true on every deploy, no clip needed. The intro-video
  // coach is the one AI card here (INTRO_VIDEO_COACH_ENABLED is on in
  // production; Pro-gated at the pipeline, and every new teacher starts on the
  // Pro trial, so a visitor signing up today can reach it).
  const more = [
    {
      icon: BellRing,
      title: t("web.landing.feature.reminders.title"),
      body: t("web.landing.feature.reminders.body"),
    },
    {
      icon: Globe,
      title: t("web.landing.feature.globalPay.title"),
      body: t("web.landing.feature.globalPay.body"),
    },
    {
      icon: CalendarClock,
      title: t("web.landing.feature.calendar.title"),
      body: t("web.landing.feature.calendar.body"),
    },
    {
      icon: Languages,
      title: t("web.landing.feature.languages.title"),
      body: t("web.landing.feature.languages.body"),
    },
    {
      icon: Clapperboard,
      title: t("web.landing.ai.videoCoach.title"),
      body: t("web.landing.ai.videoCoach.body"),
    },
  ];

  const wedgeRows = [
    {
      label: t("web.landing.wedge.row.commission.label"),
      marketplace: t("web.landing.wedge.row.commission.marketplace"),
      us: t("web.landing.wedge.row.commission.us"),
    },
    {
      label: t("web.landing.wedge.row.money.label"),
      marketplace: t("web.landing.wedge.row.money.marketplace"),
      us: t("web.landing.wedge.row.money.us"),
    },
    {
      label: t("web.landing.wedge.row.students.label"),
      marketplace: t("web.landing.wedge.row.students.marketplace"),
      us: t("web.landing.wedge.row.students.us"),
    },
  ];

  const fit = [
    {
      icon: Languages,
      title: t("web.landing.fit.language.title"),
      body: t("web.landing.fit.language.body"),
    },
    {
      icon: BookOpen,
      title: t("web.landing.fit.subject.title"),
      body: t("web.landing.fit.subject.body"),
    },
    {
      icon: Wallet,
      title: t("web.landing.fit.abroad.title"),
      body: t("web.landing.fit.abroad.body"),
    },
  ];

  const steps = [
    t("web.landing.steps.createAccount"),
    t("web.landing.steps.share"),
    t("web.landing.steps.teach"),
  ];

  const trustPills = [
    t("web.landing.trust.keepAll"),
    t("web.landing.trust.freePlan"),
    t("web.landing.trust.openSource"),
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
  const featureList = [...tour, ...more].map((f) => f.title);

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

      {/* Hero — the promise on the left, a student booking on a phone on the
          right. The clip is the product's front door seen the way a student
          sees it, which is the thing a teacher is deciding whether to share. */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute top-[-12%] left-1/3 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute top-[26%] right-[6%] h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
        </div>

        <div className="container grid items-center gap-12 py-14 lg:grid-cols-2 lg:py-20">
          <div className="flex flex-col items-center gap-6 text-center lg:items-start lg:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/60 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden />
              {t("web.landing.eyebrow")}
            </span>

            <Heading level={1} className="max-w-reading text-balance lg:text-display">
              {t("web.landing.headline")}
            </Heading>

            <p className="max-w-reading text-lg text-pretty text-muted-foreground">
              {t("web.landing.sub")}
            </p>

            <div className="mt-2 flex w-full flex-col items-center gap-3 lg:w-auto lg:flex-row">
              {loggedInCta ? (
                <Button asChild size="lg" className="w-full lg:w-auto">
                  <Link href={loggedInCta.href}>{loggedInCta.label}</Link>
                </Button>
              ) : (
                <Button asChild size="lg" className="w-full lg:w-auto">
                  <a href="/sign-up">{t("web.landing.cta")}</a>
                </Button>
              )}
              <Button asChild size="lg" variant="outline" className="w-full lg:w-auto">
                <a href={`#${TOUR_ID}`}>{t("web.landing.ctaTour")}</a>
              </Button>
            </div>

            <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground lg:justify-start">
              {trustPills.map((pill) => (
                <li key={pill} className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                  {pill}
                </li>
              ))}
            </ul>

            {!loggedInCta && (
              <p className="text-sm text-muted-foreground">
                {t("landing.studentPrompt")}{" "}
                <a
                  href="/sign-in"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {t("landing.studentCta")}
                </a>
              </p>
            )}
          </div>

          <div className="flex flex-col items-center gap-3">
            <FeatureClip
              name="booking"
              label={t("web.landing.clip.booking")}
              orientation="portrait"
              className="w-full max-w-64"
            />
            <p className="max-w-xs text-center text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {t("web.landing.feature.book.title")}
              </span>{" "}
              {t("web.landing.feature.book.body")}
            </p>
          </div>
        </div>
      </section>

      {/* The wedge — a tool, not a marketplace. Three rows a teacher who has
          paid a commission will recognise, without a competitor's number in
          them: a figure quoted here would be a claim nothing in this repository
          can verify next month. */}
      <Section
        variant="band"
        eyebrow={t("web.landing.wedge.eyebrow")}
        title={t("web.landing.wedge.title")}
        description={t("web.landing.wedge.sub")}
      >
        {/* Three columns from md up; on a phone each row becomes a card with
            the two answers stacked, because three columns of sentences do not
            fit in 390px without a horizontal scroll. */}
        <div className="hidden overflow-hidden rounded-2xl border bg-card shadow-xs md:block">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-secondary/40">
                <th scope="col" className="sr-only">
                  {t("web.landing.wedge.eyebrow")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-muted-foreground">
                  {t("web.landing.wedge.marketplace.label")}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-primary">
                  {t("web.landing.wedge.us.label")}
                </th>
              </tr>
            </thead>
            <tbody>
              {wedgeRows.map((row) => (
                <tr key={row.label} className="border-b align-top last:border-b-0">
                  <th scope="row" className="px-4 py-4 font-medium whitespace-nowrap">
                    {row.label}
                  </th>
                  <td className="px-4 py-4 text-muted-foreground">{row.marketplace}</td>
                  <td className="px-4 py-4 font-medium">{row.us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="flex flex-col gap-3 md:hidden">
          {wedgeRows.map((row) => (
            <li key={row.label} className="rounded-2xl border bg-card p-4 text-sm shadow-xs">
              <p className="font-display font-semibold">{row.label}</p>
              <p className="mt-2 text-muted-foreground">
                <span className="font-medium">{t("web.landing.wedge.marketplace.label")}:</span>{" "}
                {row.marketplace}
              </p>
              <p className="mt-1">
                <span className="font-medium text-primary">{t("web.landing.wedge.us.label")}:</span>{" "}
                {row.us}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {t("web.landing.wedge.us.note")}
        </p>
      </Section>

      {/* The tour — one job per section, the real screen beside the words. */}
      <section id={TOUR_ID} className="scroll-mt-8">
        <Section
          width="wide"
          eyebrow={t("web.landing.tour.eyebrow")}
          title={t("web.landing.tour.title")}
          description={t("web.landing.tour.sub")}
        >
          <ol className="flex flex-col gap-16 lg:gap-20">
            {tour.map((job, i) => {
              const flip = i % 2 === 1;
              return (
                <li key={job.clip} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
                  <div className={cn("max-w-reading", flip && "lg:order-2")}>
                    <Heading level={2} as="h3" className="text-balance">
                      {job.title}
                    </Heading>
                    <p className="mt-4 leading-relaxed text-pretty text-muted-foreground">
                      {job.body}
                    </p>
                  </div>
                  <div className={cn("flex flex-col gap-2", flip && "lg:order-1")}>
                    <FeatureClip
                      name={job.clip}
                      label={job.label}
                      orientation={job.portrait ? "portrait" : "landscape"}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      {t("web.landing.clipNote")}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Section>
      </section>

      {/* The rest of the job */}
      <Section variant="band" width="wide" title={t("web.landing.featuresTitle")}>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {more.map((feature) => (
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
            href={href("/features")}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("web.landing.seeAllFeatures")}
          </Link>
        </div>
      </Section>

      {/* Built for how you teach */}
      <Section
        width="wide"
        title={t("web.landing.fit.title")}
        description={t("web.landing.fit.sub")}
      >
        <div className="grid gap-5 md:grid-cols-3">
          {fit.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} body={item.body} />
          ))}
        </div>
      </Section>

      {/* The teacher it was built with. One quotation, whole sentences, in her
          own words and her own language. */}
      <Section
        variant="band"
        title={t("web.landing.social.title")}
        description={t("web.landing.social.body")}
      >
        <figure className="rounded-2xl border bg-card p-6 shadow-xs lg:p-8">
          <blockquote className="font-display text-lg leading-relaxed text-pretty lg:text-xl">
            “{TEACHER_TESTIMONIAL}”
          </blockquote>
          <figcaption className="mt-4 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("web.landing.quote.attribution")}
            </span>
            {" · "}
            {t("web.landing.quote.context")}
          </figcaption>
        </figure>
      </Section>

      {/* How it works */}
      <Section title={t("web.landing.stepsTitle")}>
        <ol className="grid gap-8 lg:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step} className="text-center lg:text-left">
              <span className="font-display text-3xl font-semibold text-primary/40 tabular-nums">
                {`0${i + 1}`}
              </span>
              <p className="mt-2 text-sm leading-relaxed text-foreground/80">{step}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* Pricing, in one line each. The figures live on /pricing, where they are
          interpolated from the live config rather than typed here. */}
      <Section
        variant="band"
        title={t("web.landing.pricing.title")}
        description={t("web.landing.pricing.body", { days: TRIAL_DAYS })}
      >
        <div className="text-center">
          <Button asChild variant="outline">
            <Link href={href("/pricing")}>{t("web.landing.seePricing")}</Link>
          </Button>
        </div>
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
