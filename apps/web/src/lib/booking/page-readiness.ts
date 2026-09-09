import { hasOfferableInstrument, isMarketplaceReady } from "@spiralclass/shared";
import type { InstrumentReadiness } from "@spiralclass/shared";

/**
 * Why a teacher's public booking page is, or is not, reachable.
 *
 * `isPubliclyListed()` (lib/marketplace-ready.ts) already decides this, and
 * `/b/<slug>` calls `notFound()` when it says no — so a teacher missing a photo
 * has a booking link that 404s for every student she sends it to. Settings →
 * Booking page never said so: it rendered the same editor either way, and the
 * link it displayed looked exactly as live as a working one.
 *
 * This is the same predicate, decomposed, so the editor can name the specific
 * thing that is holding the page down and link to where it is fixed. It stays a
 * pure function over already-loaded fields — no Prisma, no `t()` — so the
 * ordering and the gating logic can be tested without a database or a locale,
 * and so the labels stay in the catalog where the i18n guard can see them.
 *
 * The gate itself is NOT re-implemented here: `live` defers to
 * `isMarketplaceReady`, so this cannot drift into disagreeing with the code
 * that actually serves the page.
 */

/** A requirement: until every one of these is done, the page 404s. */
export type BookingPageRequirementKey =
  "onboarding" | "photo" | "bio" | "packages" | "availability" | "payouts";

/** A suggestion: the page works without these, and converts better with them. */
export type BookingPageSuggestionKey = "headline" | "video" | "targetLanguage" | "whatsapp";

export type ReadinessItem<K> = { key: K; done: boolean };

export type BookingPageReadiness = {
  /** True when students can actually open the link. */
  live: boolean;
  /** An operator-disabled account: nothing on this page can bring it back. */
  disabled: boolean;
  requirements: ReadinessItem<BookingPageRequirementKey>[];
  suggestions: ReadinessItem<BookingPageSuggestionKey>[];
  /** Requirements met, out of `requirementTotal`. Suggestions never count. */
  requirementsDone: number;
  requirementTotal: number;
  percent: number;
};

export type BookingPageReadinessInput = {
  disabledAt: Date | null;
  onboardingCompleteAt: Date | null;
  photoPath: string | null;
  bio: string | null;
  templatesTouchedAt: Date | null;
  availabilityTouchedAt: Date | null;
  stripeChargesEnabled: boolean;
  pricingCurrency: string;
  payoutInstruments: readonly InstrumentReadiness[];
  headline: string | null;
  introVideoPath: string | null;
  targetLanguage: string | null;
  publicWhatsappE164: string | null;
  /** Intro video is storage-gated; with no bucket there is nothing to suggest. */
  introVideoAvailable: boolean;
};

export function bookingPageReadiness(input: BookingPageReadinessInput): BookingPageReadiness {
  const hasPhoto = Boolean(input.photoPath);
  const hasBio = Boolean(input.bio?.trim());
  const hasPayoutMethod =
    input.stripeChargesEnabled ||
    hasOfferableInstrument(input.payoutInstruments, input.pricingCurrency);

  const requirements: ReadinessItem<BookingPageRequirementKey>[] = [
    { key: "onboarding", done: input.onboardingCompleteAt != null },
    { key: "photo", done: hasPhoto },
    { key: "bio", done: hasBio },
    { key: "packages", done: input.templatesTouchedAt != null },
    { key: "availability", done: input.availabilityTouchedAt != null },
    { key: "payouts", done: hasPayoutMethod },
  ];

  const suggestions: ReadinessItem<BookingPageSuggestionKey>[] = [
    { key: "headline", done: Boolean(input.headline?.trim()) },
    ...(input.introVideoAvailable
      ? [{ key: "video" as const, done: Boolean(input.introVideoPath) }]
      : []),
    { key: "targetLanguage", done: Boolean(input.targetLanguage) },
    { key: "whatsapp", done: Boolean(input.publicWhatsappE164) },
  ];

  const requirementsDone = requirements.filter((r) => r.done).length;
  const ready = isMarketplaceReady({
    onboardingComplete: input.onboardingCompleteAt != null,
    hasPhoto,
    hasBio,
    templatesTouched: input.templatesTouchedAt != null,
    availabilityTouched: input.availabilityTouchedAt != null,
    hasPayoutMethod,
  });

  return {
    live: ready && input.disabledAt == null,
    disabled: input.disabledAt != null,
    requirements,
    suggestions,
    requirementsDone,
    requirementTotal: requirements.length,
    percent: Math.round((requirementsDone / requirements.length) * 100),
  };
}
