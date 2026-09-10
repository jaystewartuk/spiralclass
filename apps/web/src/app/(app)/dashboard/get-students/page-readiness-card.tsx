import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { PageGapCode, PageGapSeverity, PageReadiness } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// "Your booking page" — the conversion half of getting students.
//
// A server component on purpose: it is a list of facts and links, so shipping
// a client bundle for it would buy nothing. The decision of WHETHER this
// outranks the week's posting actions is not made here — `pageReadiness`
// already made it, and this only renders the answer.
//
// The gaps were a list of rows each ending in a button labelled "Fix". Five
// identical accessible names in one list is, to a screen-reader user, five
// buttons called "Fix"; and to everyone else it is five competing filled
// controls in a card that is meant to be read top to bottom. Each gap is now
// ONE link whose name is the gap itself, so the accessible name and the visible
// text are the same sentence.

const GAP_KEY = {
  no_packages: "web.getStudents.pageGapNoPackages",
  no_photo: "web.getStudents.pageGapNoPhoto",
  no_headline: "web.getStudents.pageGapNoHeadline",
  no_bio: "web.getStudents.pageGapNoBio",
  thin_bio: "web.getStudents.pageGapThinBio",
  no_testimonials: "web.getStudents.pageGapNoTestimonials",
  no_intro_video: "web.getStudents.pageGapNoIntroVideo",
} as const satisfies Record<PageGapCode, string>;

/**
 * The word a severity carries, or none.
 *
 * `polish` deliberately gets no badge. The list is already ordered by severity,
 * and a chip on every row would make the two that change what she should do
 * this week — the one that stops a sale outright and the ones that cost her
 * most — indistinguishable from the video she has not recorded.
 */
const SEVERITY_KEY = {
  blocking: "web.getStudents.gapBlocking",
  important: "web.getStudents.gapImportant",
  polish: null,
} as const satisfies Record<PageGapSeverity, string | null>;

export async function PageReadinessCard({
  readiness,
  slug,
}: {
  readiness: PageReadiness;
  slug: string;
}) {
  const t = await getT();
  if (readiness.verdict === "ready") return null;

  // Stating the traffic it was judged on, rather than only the conclusion:
  // the number is the evidence, and a teacher who can see it can disagree
  // with it.
  const lead =
    readiness.verdict === "cannot_buy"
      ? t("web.getStudents.pageVerdictCannotBuy")
      : readiness.verdict === "traffic_not_converting"
        ? t("web.getStudents.pageVerdictNotConverting", { visits: readiness.visits })
        : t("web.getStudents.pageVerdictNotEnoughTraffic");

  return (
    <Card className={readiness.isBottleneck ? "border-primary" : undefined}>
      <CardHeader className="gap-2 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-lg" as="h2">
            {t("web.getStudents.pageTitle")}
          </CardTitle>
          {/* The border alone cannot say "this outranks your week's posting" —
              D-140: a state always carries a word as well as a colour. */}
          {readiness.isBottleneck ? (
            <Badge variant="warning">{t("web.getStudents.pageFixFirst")}</Badge>
          ) : null}
        </div>
        <CardDescription className="max-w-reading">{lead}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border border-t">
          {readiness.gaps.map((gap) => {
            const severityKey = SEVERITY_KEY[gap.severity];
            return (
              <li key={gap.code}>
                <Link
                  href={gap.href}
                  className="flex min-h-target items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden"
                >
                  <span className="min-w-0 flex-1 text-sm">{t(GAP_KEY[gap.code])}</span>
                  {severityKey ? (
                    <Badge variant={gap.severity === "blocking" ? "warning" : "secondary"}>
                      {t(severityKey)}
                    </Badge>
                  ) : null}
                  <ChevronRight
                    className="h-5 w-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="px-6 py-4">
          <Button asChild variant="outline" size="sm">
            <Link href={`/b/${slug}`}>{t("web.getStudents.pageViewYours")}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
