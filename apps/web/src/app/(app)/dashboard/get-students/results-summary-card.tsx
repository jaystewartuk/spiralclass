import Link from "next/link";
import type { FunnelTotals } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The numbers, small and last. This screen is for doing, not reading.
 *
 * Three things changed from the version this replaces. It is a `<dl>`, so each
 * number is announced with the word it belongs to instead of as three loose
 * figures. The label sits above its value, matching `StatCard` — the app's own
 * KPI tile — rather than inventing a second arrangement. And it ENDS
 * somewhere: the tile used to be the bottom of the page with nothing to click,
 * while the screen that explains every one of these numbers was a link in the
 * header the teacher had already scrolled past.
 */
export async function ResultsSummaryCard({ headline }: { headline: FunnelTotals }) {
  const t = await getT();

  const stats = [
    { key: "visits", label: t("web.getStudents.visits"), value: headline.visits },
    { key: "enquiries", label: t("web.getStudents.enquiries"), value: headline.enquiries },
    { key: "students", label: t("web.getStudents.newStudents"), value: headline.students },
  ];

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-lg" as="h2">
          {t("web.getStudents.last30")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
        {/* Says what the visit number is, because it visibly dropped when
            crawlers stopped counting and an unexplained fall in her own
            numbers reads as the product breaking. */}
        <p className="text-xs text-muted-foreground">{t("web.getStudents.realPeopleOnly")}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/get-students/results">{t("web.getStudents.seeAllResults")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
