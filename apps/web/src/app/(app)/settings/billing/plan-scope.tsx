import { Check, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import type { TFunction } from "@/lib/i18n-translate";
import type { Entitlements } from "@/lib/subscriptions/entitlements";
import type { PlanUsage, ResourceUsage } from "@/lib/subscriptions/usage";

// "What your plan covers" — the scope of the plan, stated before she runs into
// it rather than after.
//
// The caps in entitlements.ts are enforced at the mutation points and were
// surfaced NOWHERE: the only way to discover the 3-student limit was to try to
// add a fourth student and be refused mid-task. Everything here is read from
// the one entitlements resolver and the usage counts that share the gates'
// own queries, so the panel cannot drift from what the product will actually
// let her do.
//
// TWO NAMED GROUPS, not one mixed list. Every one of the Pro entitlements
// is false on Free, so a card promising to say what her plan COVERS opened
// with padlocks and nothing else — an accurate list of what she does not
// have, under a heading that promised the opposite. The always-included group
// is the answer, and it is not a consolation prize: both ways of getting paid,
// with no commission on either, is the product's central promise and Free
// carries all of it. Its lines are the same strings the public pricing page
// makes to strangers, so the two surfaces cannot come to disagree about what
// Free includes.
//
// Over-cap is a first-class state, not an error. A teacher who downgrades
// keeps every student and template she had — data is never deleted on
// downgrade — so "7 of 3" is a real thing to render honestly, together with
// the reassurance that they still work.

export function PlanScope({
  entitlements,
  usage,
  t,
}: {
  entitlements: Entitlements;
  usage: PlanUsage;
  t: TFunction;
}) {
  // True on every tier, and worth saying on the one page where a teacher is
  // being asked for money: never paywall getting paid.
  const always: string[] = [
    t("web.pricing.perk.fullScheduling"),
    t("web.pricing.perk.bothRails"),
    t("web.settings.billing.alwaysNoCommission"),
    t("web.pricing.perk.emailPushReminders"),
  ];

  // Named per entitlement flag rather than as a static "Pro perks" list: this
  // is the plan's scope, so each line has to be able to say "not on your plan"
  // as easily as "included". Most of these were absent from the old
  // "Pro unlocks" list entirely.
  const pro: Array<{ label: string; included: boolean }> = [
    {
      label: t("web.settings.billing.featureMaterials"),
      included: entitlements.canScheduleMaterials,
    },
    {
      label: t("web.settings.billing.featureCustomPricing"),
      included: entitlements.canCustomPrice,
    },
    { label: t("web.settings.billing.featureLiveNotes"), included: entitlements.canUseLiveNotes },
    {
      label: t("web.settings.billing.featureIntroVideoCoach"),
      included: entitlements.canUseIntroVideoCoach,
    },
    {
      label: t("web.settings.billing.featureHomeworkReview"),
      included: entitlements.canUseHomeworkAiReview,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-h3" as="h2">
          {t("web.settings.billing.scopeTitle")}
        </CardTitle>
        <CardDescription>
          {entitlements.isPro
            ? t("web.settings.billing.scopeDescriptionPro")
            : t("web.settings.billing.scopeDescriptionFree")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <UsageRow label={t("web.settings.billing.scopeStudents")} usage={usage.students} t={t} />
          <UsageRow
            label={t("web.settings.billing.scopeTemplates")}
            usage={usage.templates}
            t={t}
          />
        </div>

        <FeatureGroup
          id="scope-always"
          title={t("web.settings.billing.scopeAlwaysTitle")}
          features={always.map((label) => ({ label, included: true }))}
          t={t}
        />
        <FeatureGroup
          id="scope-pro"
          title={t("web.settings.billing.scopeProTitle")}
          features={pro}
          t={t}
        />
      </CardContent>
    </Card>
  );
}

// A named group of capabilities. `aria-labelledby` rather than an `aria-label`
// repeating the words: the heading is already on the page, and two copies of
// one string are two strings that can drift.
function FeatureGroup({
  id,
  title,
  features,
  t,
}: {
  id: string;
  title: string;
  features: Array<{ label: string; included: boolean }>;
  t: TFunction;
}) {
  return (
    <div className="border-t border-border pt-5">
      <Heading level={4} as="h3" id={`${id}-heading`} className="text-muted-foreground">
        {title}
      </Heading>
      <ul aria-labelledby={`${id}-heading`} className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        {features.map((feature) => (
          <li key={feature.label} className="flex items-start gap-2.5 text-sm">
            {/* The icon is decorative; the state is carried in text for a
                screen reader, because a check and a padlock are the same
                shape to one and colour alone is not a signal. */}
            {feature.included ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            ) : (
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className={feature.included ? undefined : "text-muted-foreground"}>
              {feature.label}
              <span className="sr-only">
                {" — "}
                {feature.included
                  ? t("web.settings.billing.scopeIncluded")
                  : t("web.settings.billing.scopeNotIncluded")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsageRow({ label, usage, t }: { label: string; usage: ResourceUsage; t: TFunction }) {
  // Unlimited draws no meter at all. A bar with no end is a decoration that
  // implies a limit exists, which is the opposite of what Pro means.
  if (usage.limit === null) {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {t("web.settings.billing.scopeUnlimited")}
          </span>
          {usage.used > 0 && (
            <>
              {" · "}
              {t("web.settings.billing.scopeInUse", { used: usage.used })}
            </>
          )}
        </span>
      </div>
    );
  }

  const remaining = Math.max(0, usage.limit - usage.used);
  const over = Math.max(0, usage.used - usage.limit);
  // Clamped for the BAR only — the numbers above it always tell the truth.
  const percent = Math.min(100, Math.round((usage.used / usage.limit) * 100));
  const status = usage.overLimit
    ? t("web.settings.billing.scopeOverLimit", { count: over })
    : remaining === 0
      ? t("web.settings.billing.scopeAtLimit")
      : t("web.settings.billing.scopeRemaining", { count: remaining });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums">
          {t("web.settings.billing.scopeUsedOfLimit", { used: usage.used, limit: usage.limit })}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("web.settings.billing.scopeMeterLabel", {
          used: usage.used,
          limit: usage.limit,
        })}
        aria-valuenow={usage.used}
        aria-valuemin={0}
        // Not `usage.limit`: a grandfathered teacher is legitimately over it,
        // and `valuenow` above `valuemax` is invalid ARIA that readers clamp or
        // garble. The cap itself is not lost — the label above spells out
        // "7 of 3", which is the sentence a reader should hear anyway.
        aria-valuemax={Math.max(usage.limit, usage.used)}
      >
        <div
          className={`h-full rounded-full ${usage.used >= usage.limit ? "bg-warning" : "bg-primary"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p
        className={`text-xs ${usage.used >= usage.limit ? "text-warning" : "text-muted-foreground"}`}
      >
        {status}
        {usage.overLimit && <> {t("web.settings.billing.scopeOverLimitNote")}</>}
      </p>
    </div>
  );
}
