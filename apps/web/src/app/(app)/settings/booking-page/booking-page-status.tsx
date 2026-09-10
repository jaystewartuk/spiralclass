import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Circle, ExternalLink } from "lucide-react";
import type {
  BookingPageReadiness,
  BookingPageRequirementKey,
  BookingPageSuggestionKey,
} from "@/lib/booking/page-readiness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyLinkButton } from "@/components/copy-link-button";
import { Heading } from "@/components/ui/heading";
import { getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";

// Where each unmet item is fixed. In-page anchors for the things this screen
// edits; real routes for the three that live elsewhere.
const REQUIREMENT_HREF: Record<BookingPageRequirementKey, string> = {
  onboarding: "/onboarding/timezone",
  photo: "#profile",
  bio: "#profile",
  packages: "/settings/templates",
  availability: "/settings/availability",
  payouts: "/settings/payments",
};

const SUGGESTION_HREF: Record<BookingPageSuggestionKey, string> = {
  headline: "#profile",
  video: "#video",
  targetLanguage: "#languages",
  whatsapp: "#contact",
};

function requirementLabel(key: BookingPageRequirementKey, t: TFunction): string {
  switch (key) {
    case "onboarding":
      return t("web.settings.bookingPage.status.req.onboarding");
    case "photo":
      return t("web.settings.bookingPage.status.req.photo");
    case "bio":
      return t("web.settings.bookingPage.status.req.bio");
    case "packages":
      return t("web.settings.bookingPage.status.req.packages");
    case "availability":
      return t("web.settings.bookingPage.status.req.availability");
    case "payouts":
      return t("web.settings.bookingPage.status.req.payouts");
  }
}

function suggestionLabel(key: BookingPageSuggestionKey, t: TFunction): string {
  switch (key) {
    case "headline":
      return t("web.settings.bookingPage.status.tip.headline");
    case "video":
      return t("web.settings.bookingPage.status.tip.video");
    case "targetLanguage":
      return t("web.settings.bookingPage.status.tip.targetLanguage");
    case "whatsapp":
      return t("web.settings.bookingPage.status.tip.whatsapp");
  }
}

/**
 * The answer to "is my link actually working?", at the top of the screen that
 * decides it.
 *
 * Ordered by what a teacher needs in the two states she can be in. Live: the
 * link, big, copyable, openable — she is here to share it. Not live: the reason,
 * and the shortest route to each missing piece — the link is useless until then,
 * so it is shown but not offered as something to open onto a 404.
 */
export async function BookingPageStatus({
  readiness,
  fullUrl,
  displayUrl,
}: {
  readiness: BookingPageReadiness;
  fullUrl: string;
  displayUrl: string;
}) {
  const t = await getT();
  // `readiness.disabled` is deliberately not branched on here: `requireTeacher()`
  // redirects a disabled account to `/?error=teacher-disabled` before this page
  // renders, so a "your account is paused" state on this screen would be copy
  // nobody can reach, in three locales. The flag stays in the model because it
  // is part of the same predicate `/b/<slug>` evaluates.
  const { live, requirements, suggestions, requirementsDone, requirementTotal, percent } =
    readiness;
  const openRequirements = requirements.filter((r) => !r.done);
  const openSuggestions = suggestions.filter((s) => !s.done);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {/* Same size as the section headings below it (19px, one step
                  under the page's own h1) — this card leads, so it must not
                  read as smaller than what it leads. */}
              <Heading level={3} as="h2">
                {t("web.settings.bookingPage.status.heading")}
              </Heading>
              {live ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                  {t("web.settings.bookingPage.status.liveBadge")}
                </Badge>
              ) : (
                <Badge variant="warning" className="gap-1">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  {t("web.settings.bookingPage.status.draftBadge")}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {live
                ? t("web.settings.bookingPage.status.liveBody")
                : t("web.settings.bookingPage.status.draftBody")}
            </p>
          </div>
          {live && (
            <Button asChild variant="secondary" size="sm">
              <a href={fullUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t("web.settings.bookingPage.status.viewPage")}
              </a>
            </Button>
          )}
        </div>

        {/* The link itself. `role="group"` with the label so a screen reader
            reaching the copy button knows what it copies. */}
        <div
          role="group"
          aria-label={t("bookingLink.label")}
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
        >
          <span className="flex-1 font-mono text-sm break-all">{displayUrl}</span>
          <CopyLinkButton value={fullUrl} iconOnly />
        </div>

        {!live && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">
                {t("web.settings.bookingPage.status.checklistTitle")}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {t("web.settings.bookingPage.status.progress", {
                  done: requirementsDone,
                  total: requirementTotal,
                })}
              </p>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t("web.settings.bookingPage.status.checklistTitle")}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <ul className="space-y-1">
              {openRequirements.map((item) => (
                <li key={item.key}>
                  <Link
                    href={REQUIREMENT_HREF[item.key]}
                    className="-mx-2 flex min-h-11 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden"
                  >
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">{requirementLabel(item.key, t)}</span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {live && openSuggestions.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">{t("web.settings.bookingPage.status.tipsTitle")}</p>
            <ul className="space-y-1">
              {openSuggestions.map((item) => (
                <li key={item.key}>
                  <Link
                    href={SUGGESTION_HREF[item.key]}
                    className="-mx-2 flex min-h-11 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden"
                  >
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">{suggestionLabel(item.key, t)}</span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {live && openSuggestions.length === 0 && (
          <p className="flex items-center gap-1.5 border-t pt-4 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            {t("web.settings.bookingPage.status.allDone")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
