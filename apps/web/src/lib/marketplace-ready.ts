import type { Prisma, PrismaClient } from "@prisma/client";
import { hasOfferableInstrument, isMarketplaceReady } from "@spiralclass/shared";
import type { InstrumentReadiness } from "@spiralclass/shared";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";

// Both functions below take the Prisma client as an explicit parameter
// rather than importing the `@/lib/prisma` singleton directly. This module is
// called from webhook-handler.ts, which — like wise-confirm.ts — receives its
// Prisma client via an injected `deps.prisma` for testability; a direct
// singleton import here would silently bypass that test double and hit a
// real, unconfigured Prisma client instead. That exact bug already happened
// once with maybeEmitFirstPayment (see lib/analytics/first-events.ts) — every
// call site (including the ~15 web actions/mobile routes that just pass their
// own already-imported `prisma`) is required to be explicit so it can't
// happen again here.
type MarketplaceReadyPrisma = Pick<PrismaClient, "teacher">;

// A teacher has a payout rail when Stripe can charge for her OR at least one
// of her payout instruments is offerable at her own pricing currency (D-113).
//
// The currency half matters rather than being belt-and-braces: SPEI only moves
// MXN, so a teacher priced in GBP whose only instrument is SPEI cannot in fact
// be paid, and listing her publicly would send students to a checkout with no
// usable option.
function hasPayoutRail(teacher: {
  stripeChargesEnabled: boolean;
  pricingCurrency: string;
  payoutInstruments: readonly InstrumentReadiness[];
}): boolean {
  return (
    teacher.stripeChargesEnabled ||
    hasOfferableInstrument(teacher.payoutInstruments, teacher.pricingCurrency)
  );
}

/**
 * Re-checks whether a teacher just crossed into "Marketplace Ready"
 * (the teacher-activation review —
 * onboarding complete + real profile + reviewed offer/schedule + a connected
 * payout rail) and, the FIRST time it resolves true, stamps
 * `marketplaceReadyAt` and fires the `marketplace_ready` analytics event.
 *
 * `marketplaceReadyAt` is a cache purely for this one-time analytics fire —
 * every actual gate (public listing, the dashboard checklist) always
 * recomputes isMarketplaceReady() live from current data, never reads this
 * column. The conditional `updateMany` (only writes when still null) is the
 * same "first transition" idiom `webhook-handler.ts` already uses for
 * `stripeChargesEnabled` → `payout_rail_connected`, so concurrent callers
 * can't double-fire the event.
 *
 * Call this after any mutation that could flip one of the sub-signals: the
 * onboarding wizard's templates/availability/finish actions, a profile
 * photo/bio save, or a Stripe/Wise connection.
 */
export async function maybeEmitMarketplaceReady(
  prismaClient: MarketplaceReadyPrisma,
  teacherId: string,
): Promise<void> {
  const teacher = await prismaClient.teacher.findUnique({
    where: { id: teacherId },
    select: {
      onboardingCompleteAt: true,
      photoPath: true,
      bio: true,
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      stripeChargesEnabled: true,
      pricingCurrency: true,
      payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
      marketplaceReadyAt: true,
    },
  });
  if (!teacher || teacher.marketplaceReadyAt) return;

  const ready = isMarketplaceReady({
    onboardingComplete: Boolean(teacher.onboardingCompleteAt),
    hasPhoto: Boolean(teacher.photoPath),
    hasBio: Boolean(teacher.bio),
    templatesTouched: Boolean(teacher.templatesTouchedAt),
    availabilityTouched: Boolean(teacher.availabilityTouchedAt),
    hasPayoutMethod: hasPayoutRail(teacher),
  });
  if (!ready) return;

  const { count } = await prismaClient.teacher.updateMany({
    where: { id: teacherId, marketplaceReadyAt: null },
    data: { marketplaceReadyAt: new Date() },
  });
  if (count > 0) {
    trackServerEvent({
      name: "marketplace_ready",
      distinctId: teacherId,
      properties: { teacherId },
    });
    await flushAnalytics();
  }
}

/**
 * Re-checks whether a teacher just crossed into "Profile Complete" (hasPhoto
 * && hasBio — the isMarketplaceReady() sub-signal, docs/architecture/
 * the onboarding activation audit) and, the FIRST time it
 * resolves true, stamps `profileCompletedAt` and fires the `profile_completed`
 * analytics event. Same one-time "first transition" idiom as
 * maybeEmitMarketplaceReady above, kept separate since profile completion can
 * happen well before or after the other Marketplace Ready sub-signals.
 *
 * Call this after a photo or bio save (web's saveTeacherPhotoAction/
 * saveBioAction, mobile's profile PATCH/photo POST routes) — the only two
 * fields this state depends on. Takes the Prisma client explicitly, same
 * reasoning as maybeEmitMarketplaceReady above (not currently called from a
 * DI'd context, but kept consistent so it can't become a landmine if it ever
 * is).
 */
export async function maybeEmitProfileCompleted(
  prismaClient: MarketplaceReadyPrisma,
  teacherId: string,
): Promise<void> {
  const teacher = await prismaClient.teacher.findUnique({
    where: { id: teacherId },
    select: { photoPath: true, bio: true, profileCompletedAt: true },
  });
  if (!teacher || teacher.profileCompletedAt) return;
  if (!(teacher.photoPath && teacher.bio)) return;

  const { count } = await prismaClient.teacher.updateMany({
    where: { id: teacherId, profileCompletedAt: null },
    data: { profileCompletedAt: new Date() },
  });
  if (count > 0) {
    trackServerEvent({
      name: "profile_completed",
      distinctId: teacherId,
      properties: { teacherId },
    });
    await flushAnalytics();
  }
}

export type ListingGateTeacher = {
  onboardingCompleteAt: Date | null;
  disabledAt: Date | null;
  photoPath: string | null;
  bio: string | null;
  templatesTouchedAt: Date | null;
  availabilityTouchedAt: Date | null;
  stripeChargesEnabled: boolean;
  pricingCurrency: string;
  payoutInstruments: readonly InstrumentReadiness[];
};

// The Prisma select every listing/readiness caller uses for the instrument
// relation. Exported so the ~8 call sites can't each pick a different subset
// and drift from what `InstrumentReadiness` needs.
export const INSTRUMENT_READINESS_SELECT = {
  kind: true,
  enabled: true,
  wiseHandle: true,
} as const satisfies Prisma.TeacherPayoutInstrumentSelect;

// The SQL translation of `hasPayoutRail` above lives in
// `lib/payments/payout-rail-where.ts`, not here. It is imported by
// `lib/admin-filters.ts`, which the admin teachers table pulls into the
// BROWSER — and this module imports the PostHog server client, which reaches
// `node:async_hooks`. Keeping the two apart is what stops a server-only
// dependency being dragged into a client chunk; see that file's header.

/**
 * The single public-listing gate (docs/architecture/
 * the onboarding activation audit): a teacher's booking page
 * (/b/[slug], its metadata, /b/[slug]/buy, and sitemap.ts) is only public once
 * she's Marketplace Ready AND not moderation-disabled. Applied immediately to
 * every teacher, not just new signups (operator decision, 2026-07-25) — a
 * teacher who finished the 4-step wizard with no payout rail connected was
 * previously indistinguishable, in the sitemap and on her own live page, from
 * one who could actually be paid.
 *
 * Previously this check (`!onboardingCompleteAt || disabledAt`) was repeated
 * inline at each of those 4 call sites with no shared helper — consolidated
 * here so the definition of "public" can never drift between them.
 */
export function isPubliclyListed(teacher: ListingGateTeacher): boolean {
  if (teacher.disabledAt) return false;
  return isMarketplaceReady({
    onboardingComplete: teacher.onboardingCompleteAt != null,
    hasPhoto: Boolean(teacher.photoPath),
    hasBio: Boolean(teacher.bio),
    templatesTouched: teacher.templatesTouchedAt != null,
    availabilityTouched: teacher.availabilityTouchedAt != null,
    hasPayoutMethod: hasPayoutRail(teacher),
  });
}
