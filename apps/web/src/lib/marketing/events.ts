import { AcquisitionEventKind, Prisma } from "@prisma/client";
import { matchShareGroupBySlug } from "@spiralclass/shared";
import { currentAttribution, type Attribution } from "@/lib/analytics/attribution";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { currentVisitorHash } from "./visitor";

const log = logger({ surface: "marketing" });

// Note: deliberately NOT `server-only`. This module is imported by the public
// booking page's Server Component, and the tests that render that page's
// metadata import it transitively — the same reason lib/analytics/attribution.ts
// and lib/prisma.ts don't carry the marker either. The rest of lib/marketing/*
// does.

// The acquisition ledger writer.
//
// Before this existed, first-touch attribution was captured in a cookie and
// sent to PostHog and nowhere else — which meant the PRODUCT could never answer
// "which community produced a paying student", only an operator with a PostHog
// login could. Every planner decision, every results row and every insight in
// D-125 reads this table, so the writes here are the foundation the rest sits
// on. PostHog keeps receiving exactly what it received before; this is an
// additional, teacher-owned copy.
//
// Every write is best-effort and never throws into its caller: a booking page
// must render, a lead must be captured and a payment must settle whether or not
// the analytics row lands.

export type RecordEventInput = {
  teacherId: string;
  kind: AcquisitionEventKind;
  attribution?: Attribution;
  visitorHash?: string | null;
  activityId?: string | null;
  communityId?: string | null;
  leadId?: string | null;
  studentId?: string | null;
  packageId?: string | null;
  amountMinorUnits?: number | null;
  currency?: string | null;
  viaReferral?: boolean;
  occurredAt?: Date;
};

/**
 * Resolve the community an untagged-but-UTM-tagged visit came from.
 *
 * `utm_content` carries the share-group slug minted by `shareGroupSlug` in
 * @spiralclass/shared, which is rename-tolerant by design (it pins a 4-hex id
 * suffix). Reusing that matcher rather than inventing a second scheme is what
 * makes links a teacher posted BEFORE D-125 attribute correctly today.
 */
export async function resolveCommunityFromAttribution(
  teacherId: string,
  attribution: Attribution,
): Promise<string | null> {
  if (!attribution.content) return null;
  const groups = await prisma.teacherShareGroup.findMany({
    where: { teacherId },
    select: { id: true, name: true },
  });
  return matchShareGroupBySlug(groups, attribution.content)?.id ?? null;
}

export async function recordAcquisitionEvent(input: RecordEventInput): Promise<void> {
  try {
    await prisma.acquisitionEvent.create({
      data: {
        teacherId: input.teacherId,
        kind: input.kind,
        occurredAt: input.occurredAt ?? new Date(),
        visitorHash: input.visitorHash ?? null,
        source: input.attribution?.source ?? null,
        medium: input.attribution?.medium ?? null,
        campaign: input.attribution?.campaign ?? null,
        content: input.attribution?.content ?? null,
        referrer: input.attribution?.referrer ?? null,
        activityId: input.activityId ?? null,
        communityId: input.communityId ?? null,
        leadId: input.leadId ?? null,
        studentId: input.studentId ?? null,
        packageId: input.packageId ?? null,
        amountMinorUnits: input.amountMinorUnits ?? null,
        currency: input.currency ?? null,
        viaReferral: input.viaReferral ?? false,
      },
    });
  } catch (err) {
    // Never surface: this is measurement, not the transaction.
    log.warn("acquisition event write failed", { teacherId: input.teacherId, kind: input.kind });
    if (process.env.NODE_ENV !== "production") log.error("cause", err);
  }
}

/** How long before the same browser's return counts as a fresh visit. */
const VISIT_DEDUP_HOURS = 12;

/**
 * Record a booking-page view.
 *
 * Deduped per (teacher, visitor, window) so a reload or a back button does not
 * inflate the number the teacher makes decisions on.
 *
 * Bots are dropped outright rather than left to that dedup, which cannot
 * absorb them: dedup keys on the `ap_vid` cookie and a crawler sends none, so
 * every crawler hit landed as a fresh visit while a returning human was
 * correctly collapsed — the bias ran the wrong way. Measured over
 * /b/alicia-moreno's 30 days to 2026-08-28: 765 server-rendered requests against
 * 79 client `$pageview`s from 28 people. `isBot` is required rather than
 * optional so a future call site has to decide rather than silently inherit a
 * default; see lib/marketing/bots.ts for why the decision is made in the
 * render and only the boolean travels here.
 */
export async function recordBookingPageVisit(input: {
  teacherId: string;
  attribution: Attribution;
  visitorHash: string | null;
  isBot: boolean;
  activityId?: string | null;
  communityId?: string | null;
}): Promise<void> {
  try {
    if (input.isBot) return;
    if (input.visitorHash) {
      const since = new Date(Date.now() - VISIT_DEDUP_HOURS * 60 * 60 * 1000);
      const seen = await prisma.acquisitionEvent.findFirst({
        where: {
          teacherId: input.teacherId,
          kind: "visit",
          visitorHash: input.visitorHash,
          occurredAt: { gte: since },
        },
        select: { id: true },
      });
      if (seen) return;
    }
    // Resolve which prepared action, and which community, this visit belongs
    // to. Two independent schemes, on purpose: `ap-<code>` in `campaign` is a
    // D-125 tracked link, and a share-group slug in `content` is a link the
    // teacher posted BEFORE D-125 with the old share buttons. Both must keep
    // attributing, because both are live in real community feeds right now.
    const activityId =
      input.activityId ?? (await activityFromAttribution(input.teacherId, input.attribution));
    const activityCommunityId = activityId ? await communityOfActivity(activityId) : null;
    const communityId =
      input.communityId ??
      activityCommunityId ??
      (await resolveCommunityFromAttribution(input.teacherId, input.attribution));
    await recordAcquisitionEvent({
      teacherId: input.teacherId,
      kind: "visit",
      attribution: input.attribution,
      visitorHash: input.visitorHash,
      activityId,
      communityId,
    });
  } catch (err) {
    log.warn("visit record failed", { teacherId: input.teacherId });
    if (process.env.NODE_ENV !== "production") log.error("cause", err);
  }
}

/** Record a contact-form enquiry, carrying the visitor's first-touch source. */
export async function recordEnquiry(input: { teacherId: string; leadId: string }): Promise<void> {
  const [attribution, visitorHash] = await Promise.all([
    currentAttribution(),
    currentVisitorHash(),
  ]);
  const communityId = await resolveCommunityFromAttribution(input.teacherId, attribution);
  await recordAcquisitionEvent({
    teacherId: input.teacherId,
    kind: "enquiry",
    attribution,
    visitorHash,
    leadId: input.leadId,
    communityId,
    activityId: await activityFromAttribution(input.teacherId, attribution),
  });
}

/**
 * Record a started checkout.
 *
 * This is the LAST point in the funnel where the visitor's cookie is readable —
 * a settled payment arrives on a webhook with no browser attached. So the
 * attribution is captured here and the purchase event copies it back off this
 * row, which is why `packageId` is indexed.
 */
export async function recordBookingStarted(input: {
  teacherId: string;
  packageId: string;
  studentId: string;
  viaReferral: boolean;
}): Promise<void> {
  const [attribution, visitorHash] = await Promise.all([
    currentAttribution(),
    currentVisitorHash(),
  ]);
  const communityId = await resolveCommunityFromAttribution(input.teacherId, attribution);
  await recordAcquisitionEvent({
    teacherId: input.teacherId,
    kind: "booking",
    attribution,
    visitorHash,
    packageId: input.packageId,
    studentId: input.studentId,
    communityId,
    viaReferral: input.viaReferral,
    activityId: await activityFromAttribution(input.teacherId, attribution),
  });
}

/**
 * Promote a settled payment into a `purchase` event, inheriting the attribution
 * recorded when checkout started.
 *
 * Idempotent on (package, purchase): the Stripe webhook and the manual-transfer
 * confirm path can both land, and a package can only be bought once.
 */
export async function recordPurchase(
  db: Prisma.TransactionClient | typeof prisma,
  input: {
    teacherId: string;
    packageId: string;
    studentId: string;
    amountMinorUnits: number;
    currency: string;
  },
): Promise<void> {
  try {
    const existing = await db.acquisitionEvent.findFirst({
      where: { packageId: input.packageId, kind: "purchase" },
      select: { id: true },
    });
    if (existing) return;

    const origin = await db.acquisitionEvent.findFirst({
      where: { packageId: input.packageId, kind: "booking" },
      orderBy: { occurredAt: "asc" },
    });

    await db.acquisitionEvent.create({
      data: {
        teacherId: input.teacherId,
        kind: "purchase",
        visitorHash: origin?.visitorHash ?? null,
        source: origin?.source ?? null,
        medium: origin?.medium ?? null,
        campaign: origin?.campaign ?? null,
        content: origin?.content ?? null,
        referrer: origin?.referrer ?? null,
        activityId: origin?.activityId ?? null,
        communityId: origin?.communityId ?? null,
        studentId: input.studentId,
        packageId: input.packageId,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        viaReferral: origin?.viaReferral ?? false,
      },
    });
  } catch (err) {
    log.warn("purchase event write failed", { packageId: input.packageId });
    if (process.env.NODE_ENV !== "production") log.error("cause", err);
  }
}

async function communityOfActivity(activityId: string): Promise<string | null> {
  const row = await prisma.marketingActivity.findUnique({
    where: { id: activityId },
    select: { communityId: true },
  });
  return row?.communityId ?? null;
}

/**
 * Resolve the marketing activity a visit came through, from the campaign tag
 * the tracked-link redirect stamped. Scoped to the teacher, so one teacher's
 * tag can never resolve to another's activity.
 */
export async function activityFromAttribution(
  teacherId: string,
  attribution: Attribution,
): Promise<string | null> {
  const code = trackingCodeFromAttribution(attribution);
  if (!code) return null;
  const activity = await prisma.marketingActivity.findFirst({
    where: { teacherId, trackingCode: code },
    select: { id: true },
  });
  return activity?.id ?? null;
}

/** The `utm_campaign` shape the tracked-link redirect writes: `ap-<code>`. */
export const TRACKING_CAMPAIGN_PREFIX = "ap-";

export function trackingCampaign(code: string): string {
  return `${TRACKING_CAMPAIGN_PREFIX}${code}`;
}

export function trackingCodeFromAttribution(attribution: Attribution): string | null {
  const campaign = attribution.campaign;
  if (!campaign || !campaign.startsWith(TRACKING_CAMPAIGN_PREFIX)) return null;
  const code = campaign.slice(TRACKING_CAMPAIGN_PREFIX.length);
  return /^[a-z0-9]{6,16}$/.test(code) ? code : null;
}

/**
 * Record the `purchase` event for a package that just activated.
 *
 * Called by each payment rail AFTER its transaction commits — never inside it.
 * A failed statement poisons a Postgres transaction even when its JavaScript
 * error is caught, so an analytics insert inside the settlement transaction
 * could roll back a real payment. Loads the package's own facts rather than
 * taking them as arguments, so the two rails cannot drift on what a purchase
 * is worth.
 */
export async function recordPurchaseForActivation(packageId: string): Promise<void> {
  try {
    const pkg = await prisma.package.findUnique({
      where: { id: packageId },
      select: {
        teacherId: true,
        studentId: true,
        pricePaidMinorUnits: true,
        currency: true,
        status: true,
      },
    });
    // Only an activated package is a student. A superseded or refunded one
    // reaching here would otherwise inflate the teacher's headline numbers.
    if (!pkg || pkg.status !== "active") return;
    await recordPurchase(prisma, {
      teacherId: pkg.teacherId,
      packageId,
      studentId: pkg.studentId,
      amountMinorUnits: pkg.pricePaidMinorUnits,
      currency: pkg.currency,
    });
  } catch (err) {
    log.warn("purchase activation record failed", { packageId });
    if (process.env.NODE_ENV !== "production") log.error("cause", err);
  }
}
