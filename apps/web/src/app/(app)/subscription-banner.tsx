import Link from "next/link";
import { billingSummary } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";
import { getSubscription } from "@/lib/subscriptions/service";

// Persistent trial / past_due banner shown across the teacher app. Best-effort:
// a missing subscription renders nothing.
//
// The disposition comes from the SAME `billingSummary` resolver the billing
// page uses, so the banner and the page cannot disagree about what is about to
// happen — the two used to compute the trial countdown independently, from the
// same row, with the same arithmetic written out twice.
//
// A deliberate cancellation (`ends`) gets NO banner on purpose. She chose it,
// the billing page states it plainly, and following her around the product to
// point out a decision she already made is nagging, not helping. Only the two
// states that will cost her something unless she acts appear here.
export async function SubscriptionBanner({ teacherId }: { teacherId: string }) {
  const sub = await getSubscription(teacherId);
  if (!sub) return null;
  const summary = billingSummary(sub, new Date());
  const t = await getT();

  if (
    summary.disposition === "grace_ends" ||
    (summary.disposition === "none" && summary.needsAttention)
  ) {
    return (
      <div className="bg-destructive px-4 py-2 text-center text-sm text-destructive-foreground">
        {t("web.subscriptionBanner.pastDue")}{" "}
        <Link href="/settings/billing" className="font-semibold underline">
          {t("web.subscriptionBanner.updatePayment")}
        </Link>
      </div>
    );
  }

  if (summary.disposition === "trial_ends") {
    return (
      <div className="bg-warning-bg px-4 py-2 text-center text-sm text-warning">
        {/* `count` selects the CLDR plural variant; this printed "1 day(s)
            left" on the last day of every trial before that existed. */}
        {t("web.subscriptionBanner.trialing", { count: summary.daysRemaining ?? 0 })}{" "}
        <Link href="/settings/billing" className="font-semibold underline">
          {t("web.subscriptionBanner.choosePlan")}
        </Link>
      </div>
    );
  }

  return null;
}
