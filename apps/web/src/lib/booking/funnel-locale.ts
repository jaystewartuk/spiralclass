import { cache } from "react";
import { publicFunnelLocaleFor, type AppLocale } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

/**
 * The locale a teacher's public funnel renders in, resolved from her booking
 * slug — the single source both halves of the funnel read (the `[slug]` layout
 * for Client Components, and each page's `getPublicFunnelT`). It is the
 * language SHE chose for the page (`booking_page_locale`), not her own UI
 * locale: the two are different facts and do diverge.
 *
 * `cache()`-wrapped so the layout and the page it wraps share one query per
 * request rather than each paying for their own. An unknown slug resolves to
 * the fallback locale rather than throwing: the page below it owns the 404,
 * and a layout that threw would turn a missing booking page into a 500.
 */
export const funnelLocaleForSlug = cache(async (slug: string): Promise<AppLocale> => {
  const teacher = await prisma.teacher.findUnique({
    where: { bookingSlug: slug },
    select: { bookingPageLocale: true },
  });
  return publicFunnelLocaleFor(teacher?.bookingPageLocale);
});
