import { Gift, HandCoins, Share2 } from "lucide-react";
import { formatMinorUnits } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { HelpTip } from "@/components/help-tip";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { getReferralDashboard, type ReferralActivityStatus } from "@/lib/referrals/dashboard";
import { formatDateInZone } from "@/lib/tz";
import { ReferralProgramForm, type ProgramInitial } from "./referral-program-form";

// The teacher's referral surface: one program per teacher, off by default,
// free on every tier (D-24).
//
// The ORDER of this page is adaptive, on the same principle as
// /dashboard/get-students: a screen shows you what to DO before what to read.
// Before the first referral there is nothing to read, so the explanation of the
// mechanic comes first and the numbers do not exist. Once referrals are
// arriving, the numbers are the reason she opened the page and the explanation
// drops below the form she came to adjust.

const STATUS_KEY = {
  awaiting: "web.dashboard.referrals.activity.awaiting",
  rewarded: "web.dashboard.referrals.activity.rewarded",
  void: "web.dashboard.referrals.activity.void",
} as const;

// Every state carries a WORD, never hue alone (D-140) — `secondary` is the
// deliberate neutral for "nothing has happened yet", not a missing colour.
const STATUS_VARIANT: Record<ReferralActivityStatus, "success" | "secondary" | "outline"> = {
  awaiting: "secondary",
  rewarded: "success",
  void: "outline",
};

export default async function ReferralsPage() {
  const teacher = await requireOnboardedTeacher();
  const [t, locale, dashboard] = await Promise.all([
    getT(),
    getPreferredLocale(),
    getReferralDashboard(teacher),
  ]);

  const initial: ProgramInitial = {
    enabled: dashboard.enabled,
    referred: dashboard.referred,
    referrer: dashboard.referrer,
    rewardExpiryDays: dashboard.rewardExpiryDays,
    samplePackage: dashboard.samplePackage,
  };

  const { stats, activity } = dashboard;
  const hasHistory = activity.length > 0;

  const howItWorks = (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.referrals.how.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Vertical, at every width. Three columns inside a reading-width
            column gave each step about 200px and eight-line paragraphs; a
            sequence also reads down rather than across. */}
        <ol className="space-y-5">
          {(
            [
              { icon: Share2, step: "step1" },
              { icon: HandCoins, step: "step2" },
              { icon: Gift, step: "step3" },
            ] as const
          ).map(({ icon: Icon, step }, index) => (
            <li key={step} className="flex gap-3">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 space-y-1">
                {/* The number is what makes this a sequence rather than three
                    features, and it has to be readable rather than inferred
                    from left-to-right order that stacking destroys. */}
                <p className="font-semibold">
                  {index + 1}. {t(`web.dashboard.referrals.how.${step}`)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(`web.dashboard.referrals.how.${step}Body`)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <p className="border-t pt-4 text-sm text-muted-foreground">
          {t("web.dashboard.referrals.how.cost")}
        </p>
      </CardContent>
    </Card>
  );

  return (
    <PageShell width="default">
      {/* The status badge belongs BESIDE the title, not in the actions slot:
          this page's title block is full width, so an action wraps to a line
          of its own and a lone badge there reads as orphaned rather than as
          the heading's state. */}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {t("web.dashboard.referrals.title")}
            <Badge variant={dashboard.enabled ? "success" : "outline"}>
              {dashboard.enabled
                ? t("web.dashboard.referrals.status.live")
                : t("web.dashboard.referrals.status.off")}
            </Badge>
            <HelpTip
              text={t("web.dashboard.referrals.how.cost")}
              label={t("web.dashboard.referrals.how.title")}
              learnMoreHref="/help/teacher/discounts-and-referrals"
              learnMoreLabel={t("web.help.learnMore")}
            />
          </span>
        }
        description={t("web.dashboard.referrals.subtitle")}
      />

      {hasHistory && (
        <section className="space-y-3" aria-labelledby="referral-results">
          <Heading level={3} as="h2" id="referral-results">
            {t("web.dashboard.referrals.results.title")}
          </Heading>
          {/* One card rather than four. As separate cards a formatted money
              amount wraps to two lines and stretches every sibling to match,
              leaving three tiles two-thirds empty; inside a single surface an
              uneven cell is invisible. */}
          <Card>
            <CardContent className="grid grid-cols-2 gap-6 py-6 text-center lg:grid-cols-4">
              {[
                {
                  key: "sharers",
                  label: t("web.dashboard.referrals.results.sharers", { count: stats.sharers }),
                  value: stats.sharers,
                },
                {
                  key: "friends",
                  label: t("web.dashboard.referrals.results.friends", { count: stats.friends }),
                  value: stats.friends,
                },
                {
                  key: "rewarded",
                  label: t("web.dashboard.referrals.results.rewarded", { count: stats.rewarded }),
                  value: stats.rewarded,
                },
                {
                  key: "revenue",
                  label: t("web.dashboard.referrals.results.revenue"),
                  value: formatMinorUnits(stats.revenueMinorUnits, dashboard.currency),
                },
              ].map((tile) => (
                <div key={tile.key} className="space-y-1">
                  <div className="text-2xl font-semibold tabular-nums">{tile.value}</div>
                  <div className="text-sm text-muted-foreground">{tile.label}</div>
                </div>
              ))}
              {/* What the top-line number cost, said plainly rather than left
                  for her to work out from her own price list. */}
              <p className="col-span-2 text-left text-sm text-muted-foreground lg:col-span-4">
                {t("web.dashboard.referrals.results.cost", {
                  amount: formatMinorUnits(stats.discountMinorUnits, dashboard.currency),
                })}
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Before the first referral, the mechanic is the thing she needs; after
          it, the form is. */}
      {!hasHistory && howItWorks}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.dashboard.referrals.programSettings")}</CardTitle>
          <CardDescription>
            {dashboard.enabled
              ? t("web.dashboard.referrals.status.liveBody")
              : t("web.dashboard.referrals.status.offBody")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReferralProgramForm initial={initial} />
        </CardContent>
      </Card>

      {hasHistory ? (
        <section className="space-y-3" aria-labelledby="referral-activity">
          <Heading level={3} as="h2" id="referral-activity">
            {t("web.dashboard.referrals.activity.title")}
          </Heading>
          <Card>
            <CardContent className="p-0">
              <ul>
                {activity.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b p-4 last:border-b-0"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-medium">
                        {row.friendName ?? t("web.dashboard.referrals.activity.unknownStudent")}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t("web.dashboard.referrals.activity.referredBy", {
                          referrer:
                            row.referrerName ??
                            t("web.dashboard.referrals.activity.unknownStudent"),
                        })}
                        {" · "}
                        {formatDateInZone(row.createdAt, teacher.timezone, locale)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {t("web.dashboard.referrals.activity.discountGiven", {
                          amount: formatMinorUnits(row.discountMinorUnits, row.currency),
                        })}
                      </span>
                      <Badge variant={STATUS_VARIANT[row.status]}>
                        {t(STATUS_KEY[row.status])}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      ) : (
        // Only while she is actually waiting for one. With the program off
        // there is nothing to be empty of, and a placeholder there would say
        // the product is missing something rather than switched off.
        dashboard.enabled && (
          <EmptyState
            icon={Gift}
            title={t("web.dashboard.referrals.activity.empty")}
            description={t("web.dashboard.referrals.activity.emptyBody")}
          />
        )
      )}

      {hasHistory && howItWorks}
    </PageShell>
  );
}
