import "server-only";
import { randomBytes } from "node:crypto";
import { MarketingActivityStatus, Prisma } from "@prisma/client";
import {
  communityAllowsLink,
  contentKindSpec,
  DEFAULT_PROMOTION_RULES,
  isMarketingContentKind,
  isMarketingPlatform,
  platformSpec,
  type MarketingContentKind,
  type MarketingPlatform,
  type PlanReason,
  type PromotionRules,
  type PromoPolicy,
} from "@spiralclass/shared";
import { serverEnv, socialPreviewAiEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { generateSocialPreviewImage } from "@/lib/social-preview/generate";
import { socialPreviewImagePublicUrl } from "@/lib/storage/social-preview-image";
import { getCommunity, type CommunityView } from "./communities";
import { generateMarketingContent } from "./content";
import { buildImageTopic } from "./prompt";
import { buildTeacherContext, type TeacherContext } from "./profile";

const log = logger({ surface: "marketing" });

// One prepared acquisition action: what to post, where, with what image, and
// the tracked link that closes the loop.
//
// The teacher-facing promise this module implements is "SpiralClass prepares
// the work, you approve and act". So generation is server-side and complete —
// body, image and link land together — and the only thing left for her is the
// part a platform's rules require a human to do: actually posting it.

// ── Tracking links ─────────────────────────────────────────────────────────

/** 10 lowercase base32-ish chars: ~50 bits, unguessable, still typeable. */
const TRACKING_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newTrackingCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += TRACKING_ALPHABET[bytes[i] % TRACKING_ALPHABET.length];
  return out;
}

/**
 * The teacher-visible tracked link.
 *
 * Short and clean on purpose. A booking URL with four utm parameters hanging
 * off it looks like an ad in a community feed, which is exactly the impression
 * that gets a post removed — and teachers were, understandably, editing them
 * off, which silently destroyed the attribution. `/g/<code>` carries the same
 * information in a form nobody minds pasting.
 */
export function trackedLinkFor(code: string): string {
  return `${serverEnv().APP_URL.replace(/\/$/, "")}/g/${code}`;
}

// ── Views ──────────────────────────────────────────────────────────────────

export type ActivityView = {
  id: string;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  status: MarketingActivityStatus;
  title: string | null;
  body: string | null;
  angleNote: string | null;
  reason: PlanReason | null;
  notes: string | null;
  trackingCode: string | null;
  trackedLink: string | null;
  imageUrl: string | null;
  community: { id: string; name: string; url: string | null; platform: MarketingPlatform } | null;
  student: { id: string; name: string } | null;
  completedAt: Date | null;
  createdAt: Date;
  /** Live funnel results attributed to this activity. */
  results: { visits: number; enquiries: number; students: number };
};

const ACTIVITY_INCLUDE = {
  community: { select: { id: true, name: true, url: true, platform: true } },
  student: { select: { id: true, name: true } },
  image: { select: { storagePath: true } },
} satisfies Prisma.MarketingActivityInclude;

type ActivityRow = Prisma.MarketingActivityGetPayload<{ include: typeof ACTIVITY_INCLUDE }>;

function toView(
  row: ActivityRow,
  results: { visits: number; enquiries: number; students: number },
): ActivityView {
  return {
    id: row.id,
    kind: isMarketingContentKind(row.kind) ? row.kind : "tip",
    platform: isMarketingPlatform(row.platform) ? row.platform : "other",
    status: row.status,
    title: row.title,
    body: row.body,
    angleNote: row.angleNote,
    reason: (row.reason as PlanReason | null) ?? null,
    notes: row.notes,
    trackingCode: row.trackingCode,
    trackedLink: row.trackingCode ? trackedLinkFor(row.trackingCode) : null,
    imageUrl: row.image ? socialPreviewImagePublicUrl(row.image.storagePath) : null,
    community: row.community
      ? {
          id: row.community.id,
          name: row.community.name,
          url: row.community.url,
          platform: isMarketingPlatform(row.community.platform) ? row.community.platform : "other",
        }
      : null,
    student: row.student ? { id: row.student.id, name: row.student.name } : null,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    results,
  };
}

/** Per-activity funnel counts, in one grouped query for the whole set. */
async function resultsFor(
  activityIds: string[],
): Promise<Map<string, { visits: number; enquiries: number; students: number }>> {
  const out = new Map<string, { visits: number; enquiries: number; students: number }>();
  if (activityIds.length === 0) return out;
  const rows = await prisma.acquisitionEvent.groupBy({
    by: ["activityId", "kind"],
    where: { activityId: { in: activityIds } },
    _count: { _all: true },
  });
  for (const r of rows) {
    if (!r.activityId) continue;
    const entry = out.get(r.activityId) ?? { visits: 0, enquiries: 0, students: 0 };
    if (r.kind === "visit") entry.visits = r._count._all;
    else if (r.kind === "enquiry") entry.enquiries = r._count._all;
    else if (r.kind === "purchase") entry.students = r._count._all;
    out.set(r.activityId, entry);
  }
  return out;
}

export async function listActivities(
  teacherId: string,
  opts: { planId?: string; status?: MarketingActivityStatus[]; limit?: number } = {},
): Promise<ActivityView[]> {
  const rows = await prisma.marketingActivity.findMany({
    where: {
      teacherId,
      ...(opts.planId ? { planId: opts.planId } : {}),
      ...(opts.status ? { status: { in: opts.status } } : {}),
    },
    orderBy: [{ createdAt: "asc" }],
    take: opts.limit ?? 50,
    include: ACTIVITY_INCLUDE,
  });
  const results = await resultsFor(rows.map((r) => r.id));
  return rows.map((r) => toView(r, results.get(r.id) ?? { visits: 0, enquiries: 0, students: 0 }));
}

export async function getActivity(teacherId: string, id: string): Promise<ActivityView | null> {
  const row = await prisma.marketingActivity.findFirst({
    where: { id, teacherId },
    include: ACTIVITY_INCLUDE,
  });
  if (!row) return null;
  const results = await resultsFor([row.id]);
  return toView(row, results.get(row.id) ?? { visits: 0, enquiries: 0, students: 0 });
}

// ── Creation ───────────────────────────────────────────────────────────────

export type CreateActivityInput = {
  teacherId: string;
  planId?: string | null;
  communityId?: string | null;
  studentId?: string | null;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  reason?: PlanReason | null;
};

/**
 * A tracking code is minted only when the content kind carries a link AND the
 * platform, the community's promotion policy and the community's OWN recorded
 * rules all allow one inline. Minting one for a Reddit comment, or for a group
 * whose pinned rules say "links in comments only", would create a link the
 * teacher is told not to use — an invitation to break a rule, generated by us.
 *
 * This is the deterministic half of the promotion configuration: a structured
 * "no links" answer is enforced in the data, not merely mentioned to a model.
 */
function shouldMintTrackingCode(input: {
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  rules: PromotionRules;
}): boolean {
  if (!contentKindSpec(input.kind).wantsLink) return false;
  // WhatsApp referral asks are a direct message to a known student — the
  // platform's "inline" placement plus an open policy is the normal case.
  return communityAllowsLink({
    platform: input.platform,
    promoPolicy: input.promoPolicy,
    rules: input.rules,
  });
}

export async function createActivity(input: CreateActivityInput): Promise<string> {
  // Ownership is re-established here rather than trusted from the caller: a
  // community id arriving from a form is an untrusted value, and the FK alone
  // would happily point at another teacher's row.
  const communityId = input.communityId
    ? ((
        await prisma.teacherShareGroup.findFirst({
          where: { id: input.communityId, teacherId: input.teacherId },
          select: { id: true },
        })
      )?.id ?? null)
    : null;
  const studentId = input.studentId
    ? ((
        await prisma.teacherStudent.findFirst({
          where: { studentId: input.studentId, teacherId: input.teacherId },
          select: { studentId: true },
        })
      )?.studentId ?? null)
    : null;

  const community = communityId ? await getCommunity(input.teacherId, communityId) : null;
  const { promoPolicy, rules } = promotionFor(community, input.platform);
  const mint = shouldMintTrackingCode({
    kind: input.kind,
    platform: input.platform,
    promoPolicy,
    rules,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await prisma.marketingActivity.create({
        data: {
          teacherId: input.teacherId,
          planId: input.planId ?? null,
          communityId,
          studentId,
          kind: input.kind,
          platform: input.platform,
          reason: (input.reason ?? undefined) as Prisma.InputJsonValue | undefined,
          trackingCode: mint ? newTrackingCode() : null,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Unique collision on the tracking code — astronomically unlikely, but
      // the retry is two lines and the alternative is a 500 on a cron.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("marketing-activity-create-failed");
}

/** The policy and rules that govern one activity. No community — a referral
 * ask, an ad-hoc broadcast — falls back to the platform's own conservative
 * default and no extra rules, which is the same answer as before this existed. */
export function promotionFor(
  community: CommunityView | null,
  platform: MarketingPlatform,
): { promoPolicy: PromoPolicy; rules: PromotionRules } {
  if (!community) {
    return {
      promoPolicy: platformSpec(platform).defaultPromoPolicy,
      rules: DEFAULT_PROMOTION_RULES,
    };
  }
  return { promoPolicy: community.promoPolicy, rules: community.rules };
}

export async function promoPolicyFor(
  teacherId: string,
  communityId: string | null,
  platform: MarketingPlatform,
): Promise<PromoPolicy> {
  if (!communityId) return platformSpec(platform).defaultPromoPolicy;
  const community = await getCommunity(teacherId, communityId);
  // A NAMED community we cannot see is not the same as no community: it is a
  // row that is not hers, or is gone, and the safe reading of "I asked about a
  // community and got nothing back" is the strictest one, not the platform's
  // default — which for WhatsApp or Instagram would be `open`.
  if (!community) return "unknown";
  return community.promoPolicy;
}

// ── Generation ─────────────────────────────────────────────────────────────

export type PrepareResult =
  | { ok: true; activityId: string }
  | { ok: false; reason: "not-found" | "not-configured" | "throttled" | "empty" | "error" };

/**
 * Fill in an activity: generate the post, and the image when the kind wants
 * one. Idempotent-ish by design — re-running replaces the body, which IS the
 * "give me another angle" button.
 *
 * The image is best-effort: a post without a picture is still a post, and the
 * image rail has its own monthly cap the teacher may already have spent.
 */
export async function prepareActivity(input: {
  teacherId: string;
  activityId: string;
  isPro: boolean;
  topic?: string | null;
  sourcePost?: string | null;
  withImage?: boolean;
  context?: TeacherContext;
}): Promise<PrepareResult> {
  const row = await prisma.marketingActivity.findFirst({
    where: { id: input.activityId, teacherId: input.teacherId },
    select: {
      id: true,
      kind: true,
      platform: true,
      communityId: true,
      imageId: true,
      trackingCode: true,
    },
  });
  if (!row) return { ok: false, reason: "not-found" };

  const context = input.context ?? (await buildTeacherContext(input.teacherId));
  if (!context) return { ok: false, reason: "not-found" };

  const kind = isMarketingContentKind(row.kind) ? row.kind : "tip";
  const platform = isMarketingPlatform(row.platform) ? row.platform : "other";
  // Re-read through the ownership-scoped accessor rather than joining: the
  // community view is where policy, structured rules and the meme brief are
  // normalised together, and generation must never see a half-normalised row.
  const community = row.communityId ? await getCommunity(input.teacherId, row.communityId) : null;
  const { promoPolicy, rules } = promotionFor(community, platform);

  const generated = await generateMarketingContent({
    teacherId: input.teacherId,
    context,
    kind,
    platform,
    promoPolicy,
    community: community
      ? { name: community.name, audienceNote: community.audienceNote, rules }
      : null,
    link: row.trackingCode ? trackedLinkFor(row.trackingCode) : null,
    sourcePost: input.sourcePost ?? null,
    topic: input.topic ?? null,
    // Student-facing product copy is English on purpose (students are English
    // learners of the teacher's subject) — but a post going into a Spanish
    // community should be Spanish. The community's own audience decides, and
    // the teacher's locale is the best available proxy.
    outputLanguage: context.locale === "en" ? "English" : "Spanish",
  });

  if (!generated.ok) return { ok: false, reason: generated.reason };

  let imageId: string | null = row.imageId;
  const wantsImage = input.withImage ?? contentKindSpec(kind).wantsImage;
  if (wantsImage && !imageId && socialPreviewAiEnabled()) {
    try {
      const image = await generateSocialPreviewImage({
        teacherId: input.teacherId,
        isPro: input.isPro,
        teachingLanguage: context.subject,
        // The D-123 angle axis, mapped from the richer content kind. A tip is
        // a tip; anything promotional is a promo card; social proof reads as
        // motivation. One axis stays one axis (D-123) rather than growing a
        // parallel enum here.
        angle: imageAngleFor(kind),
        topic:
          generated.content.imageIdea ??
          buildImageTopic({ kind, subject: context.subject, body: generated.content.body }),
        // So the picture is briefed by the same three authors the standalone
        // generator uses: SpiralClass, the teacher, and this community.
        communityId: community?.id ?? null,
      });
      if (image.ok) imageId = image.image.id;
      else log.info("activity image skipped", { reason: image.reason });
    } catch (err) {
      log.error("activity image generation threw", err);
    }
  }

  await prisma.marketingActivity.update({
    where: { id: row.id },
    data: {
      body: generated.content.body,
      title: generated.content.title,
      angleNote: generated.content.angleNote,
      imageId,
      status: "ready",
    },
  });

  return { ok: true, activityId: row.id };
}

function imageAngleFor(kind: MarketingContentKind): "meme" | "promo" | "tip" | "motivation" {
  const spec = contentKindSpec(kind);
  if (spec.promotional) return "promo";
  if (spec.family === "social_proof") return "motivation";
  if (spec.family === "engagement") return "meme";
  return "tip";
}

// ── Teacher actions ────────────────────────────────────────────────────────

export async function markActivityDone(
  teacherId: string,
  id: string,
  notes?: string | null,
): Promise<boolean> {
  const updated = await prisma.marketingActivity.updateMany({
    where: { id, teacherId },
    data: { status: "done", completedAt: new Date(), ...(notes ? { notes } : {}) },
  });
  return updated.count > 0;
}

export async function skipActivity(teacherId: string, id: string): Promise<boolean> {
  const updated = await prisma.marketingActivity.updateMany({
    where: { id, teacherId },
    data: { status: "skipped" },
  });
  return updated.count > 0;
}

/** Teacher edits to the generated body before posting. Her words win. */
export async function updateActivityBody(
  teacherId: string,
  id: string,
  body: string,
): Promise<boolean> {
  const updated = await prisma.marketingActivity.updateMany({
    where: { id, teacherId },
    data: { body: body.slice(0, 5000) },
  });
  return updated.count > 0;
}

// ── The community's working draft ──────────────────────────────────────────

/**
 * The one live draft for a community — created on demand, reused thereafter.
 *
 * The Communities page needed post content beside each community's tracked
 * link, and the obvious wrong move was a second content system living next to
 * the activity pipeline. There is exactly one post entity in this product
 * (MarketingActivity), it already carries the body, the title, the angle note,
 * the image and the tracked link together, and it is already what the results
 * screen measures. So the page creates one of those, and nothing new exists.
 *
 * ONE draft per community, not one per (community, kind): a teacher looking at
 * a community card is asking "what am I posting there", which has a single
 * answer. Switching the kind therefore rewrites the same row — and re-decides
 * the tracking code with it, because whether a post carries a link depends on
 * the kind as much as on the community's rules. Marking it done retires it, so
 * the next generation starts a clean draft rather than overwriting a post that
 * is already live in a feed.
 */
export async function getOrCreateCommunityDraft(input: {
  teacherId: string;
  communityId: string;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
}): Promise<{ activityId: string } | null> {
  const community = await getCommunity(input.teacherId, input.communityId);
  // Ownership is established here, not trusted: the id came from a form.
  if (!community) return null;

  const existing = await prisma.marketingActivity.findFirst({
    where: {
      teacherId: input.teacherId,
      communityId: community.id,
      status: { in: ["planned", "ready"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, trackingCode: true },
  });

  if (!existing) {
    const activityId = await createActivity({
      teacherId: input.teacherId,
      communityId: community.id,
      kind: input.kind,
      platform: input.platform,
    });
    return { activityId };
  }

  if (existing.kind === input.kind) return { activityId: existing.id };

  const { promoPolicy, rules } = promotionFor(community, input.platform);
  const wantsCode = shouldMintTrackingCode({
    kind: input.kind,
    platform: input.platform,
    promoPolicy,
    rules,
  });
  await prisma.marketingActivity.update({
    where: { id: existing.id },
    data: {
      kind: input.kind,
      platform: input.platform,
      // An existing code is KEPT when the new kind still wants one: it may
      // already be pasted somewhere, and re-minting would orphan the visits it
      // has recorded. Only the transition to a kind that carries no link
      // clears it, which is the case where keeping it would offer her a link
      // the rules say she must not use.
      ...(wantsCode
        ? existing.trackingCode
          ? {}
          : { trackingCode: newTrackingCode() }
        : { trackingCode: null }),
    },
  });
  return { activityId: existing.id };
}

/** The community's current draft, if she has one. Read-only companion to the
 * function above, for rendering the card without creating anything — opening a
 * page must never mint rows. */
export async function communityDrafts(teacherId: string): Promise<Map<string, ActivityView>> {
  const rows = await prisma.marketingActivity.findMany({
    where: { teacherId, communityId: { not: null }, status: { in: ["planned", "ready"] } },
    orderBy: { createdAt: "desc" },
    include: ACTIVITY_INCLUDE,
  });
  const out = new Map<string, ActivityView>();
  for (const row of rows) {
    // Newest first, so the first row seen for a community is its live draft.
    if (row.communityId && !out.has(row.communityId)) {
      out.set(row.communityId, toView(row, { visits: 0, enquiries: 0, students: 0 }));
    }
  }
  return out;
}

/**
 * When she last actually promoted in each community — the input the "once every
 * N days" rule is measured against.
 *
 * `done` only. A generated draft she never posted is not a promotion, and
 * counting one would lock her out of a community for a fortnight because she
 * clicked Generate.
 */
export async function lastPromotedAt(teacherId: string): Promise<Map<string, Date>> {
  const rows = await prisma.marketingActivity.groupBy({
    by: ["communityId"],
    where: { teacherId, status: "done", communityId: { not: null } },
    _max: { completedAt: true },
  });
  const out = new Map<string, Date>();
  for (const row of rows) {
    if (row.communityId && row._max.completedAt) out.set(row.communityId, row._max.completedAt);
  }
  return out;
}
