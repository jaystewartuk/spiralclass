import type { AppLocale } from "@spiralclass/shared";

// The site-wide social card, one URL per language (D-193). Rendered by
// app/social-card/[locale]/route.tsx.

export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const;

/**
 * The card for a page rendered in `locale`, as `openGraph.images` and
 * `twitter.images` take it. A page that sets its own `openGraph` replaces the
 * layout's whole object, image included, so it passes this too.
 */
export function socialCardImages(locale: AppLocale) {
  return [{ url: `/social-card/${locale}`, ...SOCIAL_CARD_SIZE, alt: "SpiralClass" }];
}
