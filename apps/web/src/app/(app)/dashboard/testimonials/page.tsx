import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { listTestimonials } from "@/lib/testimonials/store";
import { AddTestimonialPanel, TestimonialCard } from "./testimonial-forms";

// Teacher editor for the public-page social proof
// (docs/features/student-acquisition.md, D-24). Teacher-authored testimonials —
// student-submitted reviews are deliberately deferred until there's volume to
// moderate, the same reasoning as the referral engine.
//
// The page answers three questions in the order she asks them: which of these
// are strangers actually seeing, what do they say, and how do I add one. So
// the only thing above the list is a warning when NOTHING is published, the
// published/hidden counts sit on the list's own heading, and the add form is
// folded to a single button so it costs the list no room — unless she has
// nothing yet, in which case it is the empty state and there is no list for it
// to push down.
export default async function TestimonialsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();

  // Same helper the booking page reads through, so the editor can never
  // disagree with it about which order these are in.
  const items = await listTestimonials(teacher.id);

  const publishedCount = items.filter((item) => item.published).length;
  const hiddenCount = items.length - publishedCount;

  return (
    <PageShell width="default">
      <PageHeader
        title={t("web.dashboard.testimonials.title")}
        description={t("web.dashboard.testimonials.subtitle")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/b/${teacher.bookingSlug}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t("web.dashboard.testimonials.viewPublicPage")}
            </Link>
          </Button>
        }
      />

      {/* Written testimonials that nobody can read are the failure mode this
          screen has: the add form saves them hidden, and nothing said so. */}
      {items.length > 0 && publishedCount === 0 && (
        <Alert variant="warning">
          <AlertTitle as="h2">{t("web.dashboard.testimonials.nonePublishedTitle")}</AlertTitle>
          <AlertDescription>{t("web.dashboard.testimonials.nonePublishedBody")}</AlertDescription>
        </Alert>
      )}

      <AddTestimonialPanel hasItems={items.length > 0} />

      {items.length > 0 && (
        <section className="space-y-4" aria-labelledby="testimonials-heading">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Heading level={3} as="h2" id="testimonials-heading">
                {t("web.dashboard.testimonials.yourTestimonials")}
              </Heading>
              <p className="text-muted-foreground text-sm">
                {items.length > 1
                  ? t("web.dashboard.testimonials.orderHint")
                  : t("web.dashboard.testimonials.previewNote")}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge variant={publishedCount > 0 ? "success" : "outline"}>
                {t("web.dashboard.testimonials.publishedCount", { count: publishedCount })}
              </Badge>
              {hiddenCount > 0 && (
                <Badge variant="outline">
                  {t("web.dashboard.testimonials.hiddenCount", { count: hiddenCount })}
                </Badge>
              )}
            </div>
          </div>

          <ul className="space-y-4">
            {items.map((item, index) => (
              <TestimonialCard key={item.id} item={item} index={index} total={items.length} />
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}
