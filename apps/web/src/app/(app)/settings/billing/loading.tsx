import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getT } from "@/lib/i18n";

// The billing page runs four queries before it can render anything — the
// subscription row (which provisions one when missing), the founding-cohort
// count, both usage counts, and the invoice history — so the settings layout
// otherwise sits blank for the whole round trip. Every other loaded screen in
// the app has a skeleton; this one did not.
//
// Shaped like the page it stands in for, at the two cards that always render:
// a `role="status"` on the outer element announces the wait once, and the
// pieces inside are `aria-hidden` (Skeleton's own default) so a reader hears
// "Loading…" rather than a dozen anonymous boxes.
export default async function BillingLoading() {
  const t = await getT();
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>

      <div className="space-y-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      {/* Plan summary: label, plan name, price, disposition strip. */}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-40" />
          </div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-16 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* What your plan covers: two meters, then two groups of capabilities. */}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <div className="grid gap-2.5 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
