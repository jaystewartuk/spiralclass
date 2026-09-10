import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JsonLd } from "@/components/json-ld";
import { formatMinorUnits } from "@/lib/money";
import { PLATFORM_MONEY_CURRENCY, STRIPE_PRICING_URL } from "@spiralclass/shared";
import { getFoundingCohortState } from "@/lib/subscriptions/service";
import { planLabel, planPriceLabel } from "@/lib/subscriptions/display";
import {
  FREE_MAX_ACTIVE_STUDENTS,
  FREE_MAX_PACKAGE_TEMPLATES,
  PLAN_PRICE_MINOR_UNITS,
  TRIAL_DAYS,
} from "@/lib/subscriptions/config";
import { pricingJsonLd, seoBaseUrl } from "@/lib/seo/jsonld";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("web.pricing.meta.title"),
    description: t("web.pricing.meta.description", {
      monthly: formatMinorUnits(PLAN_PRICE_MINOR_UNITS.monthly, PLATFORM_MONEY_CURRENCY),
      days: TRIAL_DAYS,
    }),
    alternates: { canonical: "/pricing" },
  };
}

// Reads the live founding-cohort state from the DB, so this page must NOT be
// statically prerendered (a build-time prerender both hits the DB before
// migrations run and would bake a stale "founding open" value).
export const dynamic = "force-dynamic";

// Public pricing page: three columns (Free / Pro monthly / Pro annual) with a
// founding badge when the cohort is open, and the entitlements-driven "what you
// get by upgrading" list. CTA routes to sign-up (the 30-day Pro trial).
export default async function PricingPage() {
  const locale = await getPreferredLocale();
  const t = await getT();
  const cohort = await getFoundingCohortState();

  const proPerks = [
    t("web.pricing.perk.remindersPushEmail"),
    t("web.pricing.perk.unlimitedStudents"),
    t("web.pricing.perk.unlimitedTemplates"),
    t("web.pricing.perk.materialsScheduling"),
    t("web.pricing.perk.perStudentPricing"),
  ];

  const freePerks = [
    t("web.pricing.perk.fullScheduling"),
    t("web.pricing.perk.bothRails"),
    t("web.pricing.perk.emailPushReminders"),
    t("web.pricing.perk.maxActiveStudents", { n: FREE_MAX_ACTIVE_STUDENTS }),
    t("web.pricing.perk.packageTemplateCount", { n: FREE_MAX_PACKAGE_TEMPLATES }),
  ];

  // The evergreen plans as schema.org Offers (founding is cohort-gated, so it
  // stays out of the crawlable markup). Prices come from the same config the
  // cards render from.
  const offerPlans = (["free", "monthly", "annual"] as const).map((plan) => ({
    name: planLabel(plan, locale),
    priceMinorUnits: PLAN_PRICE_MINOR_UNITS[plan],
  }));

  return (
    <PageShell width="wide">
      <JsonLd data={pricingJsonLd(seoBaseUrl(), offerPlans, PLATFORM_MONEY_CURRENCY)} />
      <header className="text-center">
        <Heading level={1}>{t("web.pricing.headline")}</Heading>
        <p className="mt-2 text-muted-foreground">{t("web.pricing.sub", { days: TRIAL_DAYS })}</p>
      </header>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {/* Free */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">{planLabel("free", locale)}</CardTitle>
            <CardDescription className="text-2xl font-semibold text-foreground">
              {planPriceLabel("free", locale)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {freePerks.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Pro Monthly */}
        <Card className="border-primary">
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              {planLabel("monthly", locale)}
              {cohort.isOpen && (
                <Badge variant="warning">
                  {t("web.pricing.foundingBadge", {
                    price: planPriceLabel("founding", locale),
                  })}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-2xl font-semibold text-foreground">
              {planPriceLabel("monthly", locale)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{t("web.pricing.everythingInFreePlus")}</p>
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {proPerks.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {cohort.isOpen && (
              <p className="text-xs text-warning">
                {t("web.pricing.foundingLockedNote", {
                  price: planPriceLabel("founding", locale),
                  cap: cohort.cap,
                })}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Pro Annual */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">{planLabel("annual", locale)}</CardTitle>
            <CardDescription className="text-2xl font-semibold text-foreground">
              {planPriceLabel("annual", locale)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("web.pricing.annualNote")}</p>
          </CardContent>
        </Card>
      </div>

      {/* D-152. The plan price above is not the whole cost of running her
          business, and under direct charges (D-143) she meets Stripe's fee on
          her OWN Stripe account without us ever showing it to her. Saying so
          here, next to the prices, is the only place the two costs can be told
          apart before she signs up. Deliberately quotes no percentage: the rate
          is Stripe's, per country and per card, and a number we cannot stand
          behind beside a "0% commission" claim is what would make this
          misleading rather than honest. */}
      <section className="mt-14">
        <Heading level={2} className="text-center">
          {t("web.pricing.fees.title")}
        </Heading>
        <p className="mt-2 text-center text-muted-foreground">{t("web.pricing.fees.intro")}</p>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle as="h3" className="text-base">
                {t("web.pricing.fees.platformLabel")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t("web.pricing.fees.platformBody")}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h3" className="text-base">
                {t("web.pricing.fees.processorLabel")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t("web.pricing.fees.processorBody")}
              </p>
              <a
                className="text-sm text-primary underline underline-offset-4"
                href={STRIPE_PRICING_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("web.pricing.fees.stripeLink")}
              </a>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h3" className="text-base">
                {t("web.pricing.fees.transferLabel")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t("web.pricing.fees.transferBody")}
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="mt-10 text-center">
        <Button asChild>
          <Link href="/sign-up">{t("web.pricing.startTrial")}</Link>
        </Button>
      </div>
    </PageShell>
  );
}
