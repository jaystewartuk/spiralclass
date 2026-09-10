import { isConnectCountrySupported, STRIPE_PRICING_URL } from "@spiralclass/shared";
import { ExternalLink } from "lucide-react";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SettingRow, SettingsSection } from "@/components/ui/settings-section";
import { SubmitButton } from "@/components/ui/submit-button";
import { HelpTip } from "@/components/help-tip";
import { startStripeConnect, disconnectStripeConnect } from "@/app/actions/stripe-connect";
import { hasStripeCreds, hasStripeEmbeddedCheckout, clientEnv } from "@/lib/env";
import { listTeacherInstruments } from "@/lib/payments/instruments";
import { DisconnectStripeButton } from "./disconnect-stripe-button";
import { resolvePayoutReadiness } from "./payout-readiness";
import { PayoutStatusPanel } from "./payout-status";
import { StripeConnectEmbeddedOnboarding } from "./stripe-connect-embedded";
import { WiseForm } from "./wise-form";

/**
 * How a teacher gets paid.
 *
 * The screen is a VERDICT followed by the controls that change it, not a stack
 * of peer cards. It used to be the latter: three `Card`s whose titles rendered
 * at the page heading's own size, so nothing on it was more or less important
 * than anything else, and the one question it exists to answer — can my
 * students pay me? — was never stated anywhere. A teacher had to read
 * "Charges enabled: pending" out of a grey box and work it out.
 *
 * Now: `PayoutStatusPanel` answers it once, at the top, from
 * `resolvePayoutReadiness` (pure, tested — every rail state is reachable in
 * production and several are awkward to pose in a browser). Below it, one
 * named `SettingsSection` per rail, in the order the status panel lists them,
 * with the page's type descending 22 / 19 / 17 the way every other settings
 * screen's does.
 *
 * The two structural facts that decide what renders are unchanged, and
 * deliberately still agree with `startStripeConnect`'s own server-side gate and
 * with the dashboard's copy: the Stripe rail appears only where the platform
 * can actually create a merchant account for her country
 * (SUPPORTED_CONNECT_COUNTRIES, D-143) or where a legacy account is already
 * linked; everyone else uses Wise.
 */
export default async function PaymentsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    disconnected?: string;
    incomplete?: string;
    error?: string;
    wise?: string;
  }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  // One row per kind (`@@unique([teacherId, kind])`), so this is a lookup, not
  // a list — each card renders its own instrument or an empty form.
  const instruments = await listTeacherInstruments(prisma, teacher.id);
  const wise = instruments.find((i) => i.kind === "wise") ?? null;
  const t = await getT();
  const params = await searchParams;
  const isLinked = Boolean(teacher.stripeAccountId);
  const payoutCountrySupported = isConnectCountrySupported(teacher.country);
  const stripeConfigured = hasStripeCreds();
  const stripeAvailable = stripeConfigured && (payoutCountrySupported || isLinked);
  const canCharge = teacher.stripeChargesEnabled;
  const canPayout = teacher.stripePayoutsEnabled;
  // Embedded onboarding needs a browser publishable key to load Connect.js;
  // without one, fall back to the existing hosted-redirect form buttons.
  const embeddedConnect = hasStripeEmbeddedCheckout();
  const publishableKey = clientEnv().NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const embedded = embeddedConnect && Boolean(publishableKey);

  const readiness = resolvePayoutReadiness({
    stripeConfigured,
    payoutCountrySupported,
    stripeAccountId: teacher.stripeAccountId,
    stripeChargesEnabled: canCharge,
    instruments,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            {t("payments.title")}
            <HelpTip
              text={t("web.help.hint.teacherPayments.text")}
              label={t("web.help.hint.teacherPayments.label")}
              learnMoreHref="/help/teacher/packages-and-payments"
              learnMoreLabel={t("web.help.learnMore")}
            />
          </span>
        }
        description={t(
          stripeAvailable
            ? "web.settings.payments.introStripeAndWise"
            : "web.settings.payments.introWiseOnly",
        )}
      />

      {/* Result banners for the post-redirect flows: Stripe Connect onboarding
          and the connect/disconnect server actions all redirect back here with
          a query param (no useActionState round-trip survives the external
          redirect), so this is the query-param convention shared with
          availability/templates rather than FormStatus. a11y matched to
          FormStatus: aria-live polite, and role="alert" for the error tone. */}
      {params.connected === "1" && (
        <Alert variant="success" aria-live="polite">
          <AlertDescription>{t("web.settings.payments.connectedNotice")}</AlertDescription>
        </Alert>
      )}
      {params.disconnected === "1" && (
        <Alert variant="warning" aria-live="polite">
          <AlertDescription>{t("web.settings.payments.disconnectedNotice")}</AlertDescription>
        </Alert>
      )}
      {params.incomplete === "1" && (
        <Alert variant="warning" aria-live="polite">
          <AlertDescription>{t("web.settings.payments.incompleteNotice")}</AlertDescription>
        </Alert>
      )}
      {params.wise === "1" && (
        <Alert variant="success" aria-live="polite">
          <AlertDescription>{t("web.settings.payments.wiseSavedNotice")}</AlertDescription>
        </Alert>
      )}
      {params.error && (
        <Alert variant="destructive" role="alert" aria-live="polite">
          <AlertDescription>{errorCopy(params.error, t)}</AlertDescription>
        </Alert>
      )}

      <PayoutStatusPanel readiness={readiness} t={t} />

      {/* Wider gaps BETWEEN groups than between the rows inside one, so the
          grouping is legible from the spacing alone — the account page's
          convention. */}
      <div className="space-y-10">
        {/* Absent entirely on a deploy with no Stripe credentials — there is no
            rail to describe, and "not available in your country" would be a
            false explanation of our own configuration. */}
        {stripeConfigured && (
          <SettingsSection
            id="stripe"
            title={t("web.settings.payments.method.card")}
            description={t(
              stripeAvailable
                ? "web.settings.payments.stripeCardHelp"
                : // Not `stripeCardHelp`: it promises money landing in her own
                  // Stripe account, which is exactly what she cannot have here.
                  "web.settings.payments.status.cardHint",
            )}
          >
            {!stripeAvailable ? (
              // Nothing for her to do here, so nothing that looks like a
              // control — the row states the fact and sends her to Wise.
              <SettingRow
                title={t("web.settings.payments.state.unavailableHere")}
                description={t("web.settings.payments.countryUnsupportedHelp")}
              />
            ) : isLinked ? (
              <>
                <SettingRow title={t("web.settings.payments.accountStatusTitle")}>
                  <dl className="divide-border divide-y text-sm">
                    <StatusRow label={t("web.settings.payments.accountIdLabel")}>
                      {/* `break-all` because an `acct_` id is 21 unbroken
                          characters and a phone is 320px wide; the old markup
                          let it push the card's own layout sideways. */}
                      <span className="font-mono text-xs break-all">{teacher.stripeAccountId}</span>
                    </StatusRow>
                    <StatusRow label={t("web.settings.payments.chargesLabel")}>
                      <Badge variant={canCharge ? "success" : "warning"}>
                        {t(
                          canCharge
                            ? "web.settings.payments.value.enabled"
                            : "web.settings.payments.value.pending",
                        )}
                      </Badge>
                    </StatusRow>
                    <StatusRow label={t("web.settings.payments.payoutsLabel")}>
                      <Badge variant={canPayout ? "success" : "warning"}>
                        {t(
                          canPayout
                            ? "web.settings.payments.value.enabled"
                            : "web.settings.payments.value.pending",
                        )}
                      </Badge>
                    </StatusRow>
                    {teacher.stripeAccountLinkedAt && (
                      <StatusRow label={t("web.settings.payments.linkedOnLabel")}>
                        {/* Her own resolved locale, not a two-way branch on it
                            — `fr` rendered as en-US dates until this stopped
                            hardcoding the pair. */}
                        {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                          teacher.stripeAccountLinkedAt,
                        )}
                      </StatusRow>
                    )}
                  </dl>

                  {/* A restricted or
                      rejected account previously looked identical to "not yet
                      verified" — surface Stripe's own reason distinctly once
                      it is on file, as the blocker it is rather than as a
                      coloured line inside a run of text. */}
                  {!canCharge && teacher.stripeRequirementsDisabledReason && (
                    <Alert variant="warning" className="mt-4">
                      <AlertDescription>
                        {t("web.settings.payments.actionNeeded", {
                          reason: teacher.stripeRequirementsDisabledReason,
                        })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* The unfinished half of onboarding, in the row that
                      reported it — embedded where Connect.js can load, the
                      hosted redirect otherwise. Same trigger point, same
                      country gate, same account-creation logic; only the
                      rendering differs. */}
                  {!canCharge && (
                    <div className="mt-4">
                      {embedded && publishableKey ? (
                        <StripeConnectEmbeddedOnboarding publishableKey={publishableKey} />
                      ) : (
                        <form action={startStripeConnect}>
                          <SubmitButton>
                            {t("web.settings.payments.continueVerification")}
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  )}
                </SettingRow>

                <SettingRow
                  title={t("web.settings.payments.disconnectRowTitle")}
                  description={t("web.settings.payments.disconnectRowDescription")}
                  action={<DisconnectStripeButton action={disconnectStripeConnect} />}
                />
              </>
            ) : (
              <SettingRow>
                <p className="text-muted-foreground text-sm">
                  {t("web.settings.payments.stripeOnboardingHelp")}
                </p>
                {embedded && publishableKey ? (
                  <StripeConnectEmbeddedOnboarding publishableKey={publishableKey} />
                ) : (
                  <form action={startStripeConnect}>
                    <SubmitButton>{t("web.settings.payments.connectStripe")}</SubmitButton>
                  </form>
                )}
              </SettingRow>
            )}
          </SettingsSection>
        )}

        <SettingsSection
          id="wise"
          title={t("web.settings.payments.method.wise")}
          description={t("web.settings.payments.wiseCardHelp")}
        >
          <SettingRow>
            <WiseForm
              enabled={wise?.enabled ?? false}
              handle={wise?.wiseHandle ?? null}
              accountHolder={wise?.accountHolder ?? null}
              email={wise?.wiseEmail ?? null}
            />
          </SettingRow>
        </SettingsSection>

        {/* D-152. Rendered only where a card rail exists, because it is only
            there that a second bill from a second company shows up. Under
            direct charges (D-143) Stripe invoices her account for its fee and
            we never see it, so this page is the only place the platform can
            tell her the two costs apart before she meets the second one in her
            Stripe dashboard. */}
        {stripeAvailable && (
          <SettingsSection
            id="fees"
            title={t("web.settings.payments.feesTitle")}
            description={t("web.settings.payments.feesBody")}
          >
            <SettingRow>
              <Button asChild variant="outline">
                <a href={STRIPE_PRICING_URL} target="_blank" rel="noopener noreferrer">
                  {t("web.settings.payments.feesStripeLink")}
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              </Button>
            </SettingRow>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}

/**
 * One labelled fact about the connected account.
 *
 * A `<dt>`/`<dd>` pair rather than two spans, for the reason `GlanceRow` is
 * one: a labelled value IS a description list, and rendering it as inline runs
 * loses both the association a screen reader reads the pair by and — as this
 * page demonstrated — any control over where the line wraps.
 */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function errorCopy(code: string, t: TFunction): string {
  switch (code) {
    case "missing-account":
      return t("web.settings.payments.error.missingAccount");
    case "unknown-account":
      return t("web.settings.payments.error.unknownAccount");
    case "refetch":
      return t("web.settings.payments.error.refetch");
    case "stripe-disabled":
      return t("web.settings.payments.error.stripeDisabled");
    case "connect-not-enabled":
      return t("web.settings.payments.error.connectNotEnabled");
    case "country-unsupported":
      return t("web.settings.payments.error.countryUnsupported");
    case "account-unreachable":
      return t("web.settings.payments.error.accountUnreachable");
    default:
      return t("web.settings.payments.error.generic");
  }
}
