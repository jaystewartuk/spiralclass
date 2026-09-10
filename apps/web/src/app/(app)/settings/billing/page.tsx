import { Info } from "lucide-react";
import { STRIPE_PRICING_URL } from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Heading } from "@/components/ui/heading";
import { HelpTip } from "@/components/help-tip";
import { PageHeader } from "@/components/ui/page-header";
import { hasBillingCreds } from "@/lib/env";
import { ensureSubscriptionForTeacher, getFoundingCohortState } from "@/lib/subscriptions/service";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import { loadPlanUsage } from "@/lib/subscriptions/usage";
import { listBillingHistory } from "@/lib/subscriptions/invoices";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { PlanSummary } from "./plan-summary";
import { PlanScope } from "./plan-scope";
import { BillingHistory } from "./billing-history";
import { PlanButtons } from "./plan-buttons";
import { planOptions } from "./plan-options";

// The plan chooser's anchor id, shared by the section and by the summary
// card's CTA so the two cannot drift apart.
const PLANS_SECTION_ID = "plans";

// Teacher "Plan & billing".
//
// Structured around the two questions a teacher opens this page to answer,
// which the previous version could not:
//
//   1. WHAT HAPPENS NEXT — and it is not always a charge. A Customer Portal
//      cancellation leaves the Stripe subscription `active` with its period end
//      untouched, so reading that date directly and labelling it "Next charge"
//      told a teacher who had just cancelled that she was about to be billed.
//      The disposition now comes from the shared `billingSummary` resolver.
//   2. WHAT DOES MY PLAN COVER — the Free caps were enforced at the mutation
//      points and surfaced nowhere, so the only way to find the 3-student limit
//      was to be refused while adding a fourth. `PlanScope` states them up
//      front, counting with the gates' own queries. It names what every plan
//      includes before what Pro adds: all six Pro entitlements are false on
//      Free, so a card headed "what your plan covers" was six padlocks and no
//      plan.
//   3. AND THEN WHAT — the summary card is the one thing a teacher reliably
//      reads, and on Free it ended with nothing to do. It now carries a link
//      to the chooser below, where ONE plan leads: the cheapest per month,
//      derived from the price table by `recommendedPlan` rather than asserted,
//      wearing the ring, the badge and the only filled button. Three equal
//      cards with three identical primary buttons handed the reader a
//      comparison the page already knew the answer to.
//
// It also stops hiding her billing history, which the webhook has been writing
// to `subscription_invoices` since the rail shipped and only the admin console
// ever read.
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string; canceled?: string; error?: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const params = await searchParams;

  // One clock for the whole render: the entitlements resolver, the billing
  // summary and the founding-cohort check all apply it, and reading
  // `new Date()` three times can straddle a boundary and render a page that
  // disagrees with itself.
  const now = new Date();
  const sub = await ensureSubscriptionForTeacher(teacher.id);
  const ent = entitlementsFor(sub, now);
  const [cohort, usage, history] = await Promise.all([
    getFoundingCohortState(now),
    loadPlanUsage(teacher.id, ent),
    listBillingHistory(teacher.id),
  ]);
  const billingConfigured = hasBillingCreds();
  // A Stripe Customer Portal exists only for a real Stripe subscription — not
  // for a comped account, and not for one an admin recorded from a Wise
  // transfer. Resolved once here so the summary card's button and the billing
  // history's "it's in the portal" note cannot disagree about whether she has
  // somewhere to go.
  const hasPortal = Boolean(sub.stripeSubscriptionId) && !sub.comped;

  // Free and trialing only. A teacher who has CANCELLED but is still inside her
  // paid period deliberately does NOT get this grid, tempting as it is to offer
  // her one: her Stripe subscription is still live, `startBillingCheckout` has
  // no guard against a second one, and choosing a plan here would leave her
  // paying two. Her route back is "Resume subscription" on the summary card,
  // which un-cancels the subscription she already has.
  const showPlans = !ent.isPro || ent.isTrialing;

  // Free→paid funnel: the teacher viewed the upgrade surface.
  if (showPlans && billingConfigured) {
    trackServerEvent({
      name: "upgrade_viewed",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, surface: "web" },
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            {t("web.settings.billing.title")}
            <HelpTip
              text={t("web.help.hint.teacherPlans.text")}
              label={t("web.help.hint.teacherPlans.label")}
              learnMoreHref="/help/teacher/settings-and-subscription"
              learnMoreLabel={t("web.help.learnMore")}
            />
          </span>
        }
        description={t("web.settings.billing.subtitle")}
      />

      {/* Result banners for the post-redirect Stripe Billing flows (Checkout
          and the Customer Portal return here with a query param — no
          useActionState round-trip survives the external redirect, so this is
          the query-param convention shared with availability/templates rather
          than FormStatus). a11y matched to FormStatus: aria-live polite, and
          role="alert" for the error tone.

          The trial and past_due banners that used to sit here are gone: they
          restated, above the card, what the card itself now says — two places
          telling one truth, which is one place too many to keep in step. */}
      {params.upgraded === "1" && (
        <Alert variant="success" aria-live="polite">
          <AlertDescription>{t("web.settings.billing.upgradedNotice")}</AlertDescription>
        </Alert>
      )}
      {params.canceled === "1" && (
        <Alert variant="warning" aria-live="polite">
          <AlertDescription>{t("web.settings.billing.canceledNotice")}</AlertDescription>
        </Alert>
      )}
      {params.error && (
        <Alert variant="destructive" role="alert" aria-live="polite">
          {/* Translated from a CODE here rather than rendered from the query
              string, which used to carry the whole localized sentence — and
              kept carrying it, in the old language, after she switched. */}
          <AlertDescription>{billingErrorCopy(params.error, t)}</AlertDescription>
        </Alert>
      )}

      <PlanSummary
        subscription={sub}
        entitlements={ent}
        hasPortal={hasPortal}
        plansHref={showPlans && billingConfigured ? `#${PLANS_SECTION_ID}` : undefined}
        locale={locale}
        timezone={teacher.timezone}
        t={t}
        now={now}
      />

      <PlanScope entitlements={ent} usage={usage} t={t} />

      {showPlans && (
        // The anchor the summary card's CTA lands on. `scroll-mt` clears the
        // 56px sticky app header, which an unadorned `#plans` jump puts the
        // heading directly underneath.
        <Card id={PLANS_SECTION_ID} className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-h3" as="h2">
              {t("web.settings.billing.plansTitle")}
            </CardTitle>
            <CardDescription>{t("web.settings.billing.plansDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {billingConfigured ? (
              <PlanButtons
                options={planOptions({ t, locale, cohort, timezone: teacher.timezone })}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("web.settings.billing.notEnabled")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <BillingHistory
        entries={history}
        locale={locale}
        timezone={teacher.timezone}
        hasPortal={hasPortal}
        t={t}
      />

      {/* D-152. Every other line on this page is money that flows to US. Since
          D-143 made her the merchant of record, the cost she actually meets per
          payment is Stripe's, billed to her own account, and it appears nowhere
          in the history above — so a teacher reading this page could reasonably
          conclude her plan is the whole cost of getting paid. It is not, and
          this says so where she is already looking at a bill. */}
      <Card className="bg-muted/40 shadow-none">
        <CardContent className="flex gap-3 pt-6">
          <Info className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-2">
            {/* At the section size, not the page's: this is a disclosure the
                reader needs to find, not a fifth thing competing with her plan
                for the top of the hierarchy. It kept the weight of "Billing
                history" while being a paragraph of caveat, and its title is a
                full sentence — which at `text-h3` wrapped to three lines and
                shouted the loudest thing on the page. */}
            <Heading level={4} as="h2">
              {t("web.settings.billing.feesTitle")}
            </Heading>
            <p className="text-muted-foreground text-sm">{t("web.settings.billing.feesBody")}</p>
            <a
              className="text-primary inline-block text-sm underline underline-offset-4"
              href={STRIPE_PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("web.settings.billing.feesStripeLink")}
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// A failure code from the portal round trip, turned back into a sentence in
// the reader's CURRENT language. Mirrors `errorCopy` on the payments page;
// the default deliberately covers a code this build does not know, since the
// query string is reachable by hand.
function billingErrorCopy(code: string, t: Awaited<ReturnType<typeof getT>>): string {
  switch (code) {
    case "unavailable":
      return t("billing.error.portalUnavailable");
    case "no-subscription":
      return t("billing.error.noSubscriptionToManage");
    case "account-not-found":
      return t("billing.error.accountNotFound");
    case "already-subscribed":
      return t("billing.error.alreadySubscribed");
    case "already-comped":
      return t("billing.error.alreadyComped");
    default:
      return t("billing.error.generic");
  }
}
