"use client";

import Image from "next/image";
import { CalendarClock, Clock3, Globe, MessageCircle, Play } from "lucide-react";
import { formatPriceForBuyer, initialsFrom, isOneClassOffering } from "@spiralclass/shared";
import { createT, type AppLocale } from "@/lib/i18n-translate";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/components/locale-provider";
import { useBookingPageDraft } from "./preview-context";

export type PreviewOffering = {
  priceMinorUnits: number;
  currency: string;
  classCount: number;
  classDurationMin: number;
  singleClass: boolean;
};

/**
 * What the teacher's public page looks like, beside the controls that change it.
 *
 * ## Why a re-render and not an iframe of the real page
 *
 * The obvious build is `<iframe src="/b/<slug>">`. Three things rule it out,
 * and they are worth writing down so it is not re-proposed:
 *
 *  1. **The CSP forbids it.** `frame-ancestors 'none'` (lib/csp.ts) blocks
 *     framing this app anywhere, same-origin included. Relaxing it to `'self'`
 *     is a clickjacking-posture change on a Tier 2 file, bought for a settings
 *     screen.
 *  2. **It would forge her own funnel numbers.** `/b/<slug>` records a visit
 *     and fires `booking_page_view` on every request that is not a bot. An
 *     editor that loads the page on mount would put the teacher's own editing
 *     sessions into the acquisition ledger she uses to judge her marketing.
 *  3. **It cannot show unsaved text**, which is most of the value: the point is
 *     to see whether a headline fits before committing to it.
 *
 * ## The cost, stated
 *
 * This is a second rendering of the hero, so it can drift from
 * `b/[slug]/page.tsx`. It is deliberately narrow — hero only, no packages
 * list, no testimonials, no checkout — so there is little surface to drift, and
 * it draws every value from the same source the real page does (the same
 * fallback headline key, the same monogram helper, the same price formatter).
 *
 * ## Locale
 *
 * Rendered with `bookingPageLocale`, never the teacher's own — that is the
 * whole point of the field (see the i18n section of CLAUDE.md). A preview in
 * her language of a page in her buyers' language would show her something no
 * visitor will ever see.
 */
export function BookingPagePreview({
  name,
  photoUrl,
  initialHeadline,
  initialBio,
  timezone,
  offering,
  hasVideo,
  hasWhatsapp,
  funnelLocale,
  displayUrl,
}: {
  name: string;
  photoUrl: string | null;
  initialHeadline: string | null;
  initialBio: string | null;
  timezone: string;
  /** Cheapest live package — the one the hero's price/duration badges quote. */
  offering: PreviewOffering | null;
  hasVideo: boolean;
  hasWhatsapp: boolean;
  funnelLocale: AppLocale;
  /** Host + path, without the scheme — the address-bar line. */
  displayUrl: string;
}) {
  const t = useT();
  // The visitor's copy. Bound to HER page's locale, not the dashboard's.
  const pt = createT(funnelLocale);

  const draft = useBookingPageDraft();
  const headline = (draft?.headline ?? initialHeadline ?? "").trim();
  const bio = (draft?.bio ?? initialBio ?? "").trim();

  const tzLabel = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      {/* Address bar. Establishes that what is below is a different page, and
          incidentally puts the live URL in the teacher's eyeline while she
          edits the slug that produces it. */}
      <div className="border-b px-3 py-2">
        <p className="truncate text-center font-mono text-xs text-muted-foreground">{displayUrl}</p>
      </div>

      <div className="space-y-4 bg-background p-5 text-center">
        <div className="space-y-1.5">
          <p className="text-lg font-semibold text-balance">
            {headline || pt("web.bookingLanding.classesWith", { name })}
          </p>
          <p className="text-xs text-muted-foreground">{pt("web.bookingLanding.tagline")}</p>
        </div>

        {photoUrl ? (
          <Image
            src={photoUrl}
            alt=""
            width={160}
            height={160}
            className="mx-auto h-28 w-28 rounded-2xl border object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="mx-auto flex h-28 w-28 items-center justify-center rounded-2xl border bg-muted"
          >
            <span className="text-3xl font-semibold text-muted-foreground">
              {initialsFrom(name)}
            </span>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-1.5">
          <Badge variant="outline" className="gap-1">
            <Globe className="h-3 w-3" aria-hidden /> {tzLabel}
          </Badge>
          {offering && (
            <>
              <Badge variant="outline" className="gap-1">
                <CalendarClock className="h-3 w-3" aria-hidden />
                {pt("web.bookingLanding.fromPrice", {
                  price: formatPriceForBuyer(
                    offering.priceMinorUnits,
                    offering.currency,
                    funnelLocale,
                  ),
                })}
              </Badge>
              <Badge variant="outline" className="gap-1">
                <Clock3 className="h-3 w-3" aria-hidden />
                {isOneClassOffering(offering)
                  ? pt("web.bookingLanding.singleClassDuration", { min: offering.classDurationMin })
                  : pt("web.bookingLanding.classCountDuration", {
                      count: offering.classCount,
                      min: offering.classDurationMin,
                    })}
              </Badge>
            </>
          )}
        </div>

        {hasVideo && (
          <div className="mx-auto flex h-20 w-full max-w-56 items-center justify-center gap-2 rounded-lg border bg-muted text-xs text-muted-foreground">
            <Play className="h-4 w-4" aria-hidden />
            {t("web.settings.bookingPage.preview.videoPlaceholder")}
          </div>
        )}

        {bio ? (
          <p className="mx-auto max-w-prose text-sm whitespace-pre-line text-foreground/80">
            {bio}
          </p>
        ) : (
          // Clearly an editor hint, not content: dashed and muted, so it can
          // never be mistaken for something a visitor would read.
          <p className="mx-auto max-w-prose rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            {t("web.settings.bookingPage.preview.bioPlaceholder")}
          </p>
        )}

        {/* The purchase card is a whole second column on the real page. One
            representative, non-interactive control stands in for it — enough to
            show where the action sits, without pretending to be it. */}
        <div className="space-y-2 pt-1">
          <span className="flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            {pt("web.bookingLanding.packagesHeading")}
          </span>
          {hasWhatsapp && (
            <span className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border text-sm font-medium text-foreground">
              <MessageCircle className="h-4 w-4" aria-hidden />
              {pt("common.chatOnWhatsApp")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
