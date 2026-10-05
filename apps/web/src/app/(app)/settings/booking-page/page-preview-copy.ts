import { formatPriceForBuyer, isOneClassOffering } from "@spiralclass/shared";
import { createT, type AppLocale } from "@/lib/i18n-translate";

export type PreviewOffering = {
  priceMinorUnits: number;
  currency: string;
  classCount: number;
  classDurationMin: number;
  singleClass: boolean;
};

/** The preview's words that a VISITOR reads, already in her booking page's
 * language. */
export type PreviewVisitorCopy = {
  /** The fallback headline, shown until she writes her own. */
  classesWith: string;
  tagline: string;
  /** The cheapest package's price and length; null when there is no package. */
  fromPrice: string | null;
  duration: string | null;
  packagesHeading: string;
  chatOnWhatsApp: string;
};

/**
 * The visitor's half of the booking-page preview, worded on the server.
 *
 * The preview speaks two languages at once: the dashboard's around it, and her
 * buyers' (`bookingPageLocale`) for the page it shows. A Client Component can
 * only speak the one its provider loaded, because loading a second means
 * loading that language's whole catalog into the browser for six strings — so
 * these six are written here, where every language is to hand, and handed down
 * finished.
 */
export function previewVisitorCopy(
  name: string,
  offering: PreviewOffering | null,
  funnelLocale: AppLocale,
): PreviewVisitorCopy {
  const t = createT(funnelLocale);
  return {
    classesWith: t("web.bookingLanding.classesWith", { name }),
    tagline: t("web.bookingLanding.tagline"),
    fromPrice: offering
      ? t("web.bookingLanding.fromPrice", {
          price: formatPriceForBuyer(
            offering.priceMinorUnits,
            offering.currency,
            funnelLocale,
            offering.currency,
          ),
        })
      : null,
    duration: offering
      ? isOneClassOffering(offering)
        ? t("web.bookingLanding.singleClassDuration", { min: offering.classDurationMin })
        : t("web.bookingLanding.classCountDuration", {
            count: offering.classCount,
            min: offering.classDurationMin,
          })
      : null,
    packagesHeading: t("web.bookingLanding.packagesHeading"),
    chatOnWhatsApp: t("common.chatOnWhatsApp"),
  };
}
