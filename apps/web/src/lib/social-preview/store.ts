import { cache } from "react";
import {
  matchShareGroupBySlug,
  normalizeSocialPreviewCaption,
  shareGroupSlug,
  socialPreviewMonthlyCap,
  type SocialPreviewAngle,
  type SocialPreviewImageView,
  type SocialPreviewSource,
  type SocialPreviewView,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { INSTRUMENT_READINESS_SELECT } from "@/lib/marketplace-ready";
import {
  removeSocialPreviewImage,
  socialPreviewImagePublicUrl,
} from "@/lib/storage/social-preview-image";

// Social previews: reads, writes and — the load-bearing part — RESOLUTION
// (D-123). It exists here so no two callers can disagree about ownership,
// ordering or fallback; the server actions are the only caller now.

/** Start of the current UTC calendar month — the quota window. Mirrors
 * lib/materials/config.ts's monthStartUtc rather than importing it, so the
 * social-preview domain doesn't take a dependency on the materials domain for
 * two lines of date arithmetic. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// --- Views -------------------------------------------------------------------

type ImageRow = {
  id: string;
  source: SocialPreviewSource;
  angle: SocialPreviewAngle | null;
  topic: string | null;
  storagePath: string;
  createdAt: Date;
};

type PreviewRow = {
  id: string;
  shareGroupId: string | null;
  caption: string;
  updatedAt: Date;
  image: ImageRow;
};

const IMAGE_SELECT = {
  id: true,
  source: true,
  angle: true,
  topic: true,
  storagePath: true,
  createdAt: true,
} as const;

const PREVIEW_SELECT = {
  id: true,
  shareGroupId: true,
  caption: true,
  updatedAt: true,
  image: { select: IMAGE_SELECT },
} as const;

function toImageView(row: ImageRow): SocialPreviewImageView {
  return {
    id: row.id,
    source: row.source,
    angle: row.angle,
    topic: row.topic,
    url: socialPreviewImagePublicUrl(row.storagePath),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Absolute URL of the COMPOSED card — what og:image points at.
 *
 * The `v` param is the whole cache-invalidation story. Facebook and WhatsApp
 * cache the first scrape of a given URL and will happily keep serving it for
 * days; the only reliable way to show a changed preview is to hand them a URL
 * they have never seen. Keying it on the placement's updatedAt means editing a
 * caption or swapping the image mints a new URL automatically, and NOT editing
 * anything keeps the URL — and therefore every warm CDN and crawler cache —
 * exactly as it was.
 */
export function socialPreviewCardUrl(previewId: string, updatedAt: Date): string {
  const base = serverEnv().APP_URL.replace(/\/$/, "");
  return `${base}/api/og/social-preview/${previewId}?v=${updatedAt.getTime()}`;
}

function toPreviewView(row: PreviewRow): SocialPreviewView {
  return {
    id: row.id,
    shareGroupId: row.shareGroupId,
    caption: row.caption,
    image: toImageView(row.image),
    cardUrl: socialPreviewCardUrl(row.id, row.updatedAt),
  };
}

// --- Teacher-facing reads ----------------------------------------------------

/** Every placement the teacher has configured, default first then by group. */
export async function listSocialPreviews(teacherId: string): Promise<SocialPreviewView[]> {
  const rows = await prisma.socialPreview.findMany({
    where: { teacherId },
    orderBy: [{ shareGroupId: "asc" }, { createdAt: "asc" }],
    select: PREVIEW_SELECT,
  });
  return rows.map(toPreviewView);
}

/** The teacher's image library — newest first, so "generate another" surfaces
 * at the top. Bounded: this feeds a picker, not an archive browser. */
export async function listSocialPreviewImages(
  teacherId: string,
  limit = 24,
): Promise<SocialPreviewImageView[]> {
  const rows = await prisma.socialPreviewImage.findMany({
    where: { teacherId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: IMAGE_SELECT,
  });
  return rows.map(toImageView);
}

/** What each stored image is actually FOR, so the library can say so.
 *
 * The community association is deliberately DERIVED from the placements rather
 * than stored as a second column on the image: the placement already means
 * "this community shows this image", and a parallel `communityId` would be a
 * second answer to one question that could disagree with the first.
 */
export type SocialPreviewImageUsage = {
  /** Names of the communities currently previewing with this image. */
  communities: string[];
  /** True when it is also the teacher's default preview for untagged shares. */
  isDefault: boolean;
  /** True when a post she has already marked done used this image — the one
   * case deletion is refused, because the picture is live in a real feed. */
  posted: boolean;
};

export async function socialPreviewImageUsage(
  teacherId: string,
): Promise<Map<string, SocialPreviewImageUsage>> {
  const [previews, posted] = await Promise.all([
    prisma.socialPreview.findMany({
      where: { teacherId },
      select: { imageId: true, shareGroup: { select: { name: true } } },
    }),
    prisma.marketingActivity.findMany({
      where: { teacherId, status: "done", imageId: { not: null } },
      select: { imageId: true },
      distinct: ["imageId"],
    }),
  ]);

  const out = new Map<string, SocialPreviewImageUsage>();
  const entry = (id: string) => {
    const existing = out.get(id) ?? { communities: [], isDefault: false, posted: false };
    out.set(id, existing);
    return existing;
  };
  for (const p of previews) {
    const e = entry(p.imageId);
    if (p.shareGroup) e.communities.push(p.shareGroup.name);
    else e.isDefault = true;
  }
  for (const a of posted) {
    if (a.imageId) entry(a.imageId).posted = true;
  }
  return out;
}

// --- Quota -------------------------------------------------------------------

export type SocialPreviewQuota = { used: number; cap: number; remaining: number };

/**
 * This calendar month's AI generations against the teacher's cap.
 *
 * Counts rows, exactly like the material-compose cap counts
 * ClassContentGeneration: the asset table IS the ledger, so there is no second
 * table that can drift from what was actually produced. Only successful
 * generations create a row, so a provider failure never costs the teacher an
 * allowance unit.
 */
export async function socialPreviewQuota(
  teacherId: string,
  isPro: boolean,
  now = new Date(),
): Promise<SocialPreviewQuota> {
  const cap = socialPreviewMonthlyCap(isPro);
  const used = await prisma.socialPreviewImage.count({
    where: { teacherId, source: "ai", createdAt: { gte: monthStartUtc(now) } },
  });
  return { used, cap, remaining: Math.max(0, cap - used) };
}

// --- Writes ------------------------------------------------------------------

/** Record a stored asset. The bytes are already in object storage by this
 * point — this is the row that makes them findable and countable. */
export function createSocialPreviewImage(input: {
  id: string;
  teacherId: string;
  source: SocialPreviewSource;
  angle?: SocialPreviewAngle | null;
  topic?: string | null;
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  storagePath: string;
  width: number;
  height: number;
}) {
  return prisma.socialPreviewImage.create({
    data: {
      id: input.id,
      teacherId: input.teacherId,
      source: input.source,
      angle: input.angle ?? null,
      topic: input.topic ?? null,
      prompt: input.prompt ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      storagePath: input.storagePath,
      width: input.width,
      height: input.height,
    },
    select: IMAGE_SELECT,
  });
}

/**
 * Rename one image — the teacher's own label for it.
 *
 * `topic` is the only editable property on an asset, and that is a deliberate
 * limit rather than an oversight: everything else on the row is either the
 * immutable provenance of a generation (prompt, provider, model, source) or the
 * storage location. Its two jobs are exactly what a label should do — tell her
 * what a thumbnail is at a glance, and seed the next "generate another".
 */
export async function renameSocialPreviewImage(input: {
  teacherId: string;
  imageId: string;
  topic: string;
}): Promise<boolean> {
  const topic = input.topic.trim().slice(0, 160);
  const updated = await prisma.socialPreviewImage.updateMany({
    where: { id: input.imageId, teacherId: input.teacherId },
    data: { topic: topic.length > 0 ? topic : null },
  });
  return updated.count > 0;
}

export type DeleteImageResult = { ok: true } | { ok: false; reason: "not-found" | "posted" };

/**
 * Delete one image, and everything that would otherwise be left dangling.
 *
 * The FK from SocialPreview and MarketingActivity is `Restrict` on purpose
 * (D-123/D-125): an asset a live share link previews must not vanish
 * underneath it. So this does not force its way past that constraint, it
 * resolves it:
 *
 *   * A post she has already MARKED DONE is live in a real community feed, and
 *     its image is part of what she posted. Deletion is refused and says so.
 *   * A draft or planned post is not public yet, so its reference is cleared —
 *     the post keeps its text and loses its picture, which is recoverable.
 *   * A placement is cleared too: the affected link falls back to the standard
 *     SpiralClass card, which is exactly what "Back to the standard card"
 *     already does and is equally reversible.
 *
 * Row first, bytes second. A storage failure then leaks an object nobody
 * references, which is a cost; the other order leaves a row pointing at bytes
 * that are gone, which is a broken image on a public page.
 */
export async function deleteSocialPreviewImage(input: {
  teacherId: string;
  imageId: string;
}): Promise<DeleteImageResult> {
  const image = await prisma.socialPreviewImage.findFirst({
    where: { id: input.imageId, teacherId: input.teacherId },
    select: { id: true, storagePath: true },
  });
  // "Not yours" and "gone" are one answer, so an id cannot be probed.
  if (!image) return { ok: false, reason: "not-found" };

  const posted = await prisma.marketingActivity.findFirst({
    where: { teacherId: input.teacherId, imageId: image.id, status: "done" },
    select: { id: true },
  });
  if (posted) return { ok: false, reason: "posted" };

  await prisma.$transaction([
    prisma.socialPreview.deleteMany({ where: { teacherId: input.teacherId, imageId: image.id } }),
    prisma.marketingActivity.updateMany({
      where: { teacherId: input.teacherId, imageId: image.id },
      data: { imageId: null },
    }),
    prisma.socialPreviewImage.deleteMany({
      where: { id: image.id, teacherId: input.teacherId },
    }),
  ]);

  await removeSocialPreviewImage(image.storagePath);
  return { ok: true };
}

export type SelectPreviewResult =
  | { ok: true; preview: SocialPreviewView }
  | { ok: false; reason: "image-not-found" | "group-not-found" };

/**
 * Attach an image (+ caption) to a share group, or to the teacher's default.
 *
 * Both the image and the group are re-checked against `teacherId` here rather
 * than trusted from the caller: this is the one write that can point a PUBLIC
 * surface at an asset, so cross-teacher references are refused at the last
 * possible moment, not only at the form.
 *
 * The teacher-default row (shareGroupId = null) is upserted by hand inside a
 * transaction because Postgres treats NULLs as distinct under a unique index,
 * so the schema-level constraint cannot bound it to one. See the SocialPreview
 * model comment for why a partial index was rejected.
 */
export async function selectSocialPreview(input: {
  teacherId: string;
  imageId: string;
  shareGroupId: string | null;
  caption: string;
}): Promise<SelectPreviewResult> {
  const caption = normalizeSocialPreviewCaption(input.caption);

  const image = await prisma.socialPreviewImage.findFirst({
    where: { id: input.imageId, teacherId: input.teacherId },
    select: { id: true },
  });
  if (!image) return { ok: false, reason: "image-not-found" };

  if (input.shareGroupId) {
    const group = await prisma.teacherShareGroup.findFirst({
      where: { id: input.shareGroupId, teacherId: input.teacherId },
      select: { id: true },
    });
    if (!group) return { ok: false, reason: "group-not-found" };

    const row = await prisma.socialPreview.upsert({
      where: { shareGroupId: input.shareGroupId },
      create: {
        teacherId: input.teacherId,
        shareGroupId: input.shareGroupId,
        imageId: input.imageId,
        caption,
      },
      update: { imageId: input.imageId, caption },
      select: PREVIEW_SELECT,
    });
    return { ok: true, preview: toPreviewView(row) };
  }

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.socialPreview.findFirst({
      where: { teacherId: input.teacherId, shareGroupId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      return tx.socialPreview.update({
        where: { id: existing.id },
        data: { imageId: input.imageId, caption },
        select: PREVIEW_SELECT,
      });
    }
    return tx.socialPreview.create({
      data: {
        teacherId: input.teacherId,
        shareGroupId: null,
        imageId: input.imageId,
        caption,
      },
      select: PREVIEW_SELECT,
    });
  });
  return { ok: true, preview: toPreviewView(row) };
}

/**
 * Drop a placement — "go back to the standard preview".
 *
 * Deletes only the placement, never the asset: the teacher may well re-select
 * it, and the image is hers. Scoped by teacherId so one teacher can never clear
 * another's preview.
 */
export async function clearSocialPreview(teacherId: string, previewId: string): Promise<boolean> {
  const deleted = await prisma.socialPreview.deleteMany({ where: { id: previewId, teacherId } });
  return deleted.count > 0;
}

// --- Public resolution -------------------------------------------------------

export type ResolvedSocialPreview = {
  id: string;
  caption: string;
  cardUrl: string;
  angle: SocialPreviewAngle | null;
  source: SocialPreviewSource;
  /**
   * The CANONICAL `utm_content` tag of the group this preview belongs to, or
   * null when it is the teacher's default (which every link resolves to, tagged
   * or not).
   *
   * Present so generateMetadata can point `og:url` at a URL that resolves back
   * to this same preview — see the comment there for why an undecorated og:url
   * silently disabled this whole feature on Facebook. Canonical rather than an
   * echo of what the visitor sent, because `matchShareGroupBySlug` also accepts
   * a stale slug from before a rename: echoing that back would mint a second
   * Facebook object for one group, and echoing arbitrary input into a meta tag
   * is a habit worth not having.
   */
  shareGroupSlug: string | null;
};

/**
 * Which preview (if any) a given shared link should show.
 *
 * Three levels, each opt-in, in order:
 *   1. the group named by `utm_content`, if that group has a preview;
 *   2. the teacher's default preview, for untagged shares;
 *   3. nothing — the caller then emits no `openGraph.images`, and Next's
 *      file-convention opengraph-image.tsx supplies today's card unchanged.
 *
 * Level 3 is why every link shared before this feature existed keeps behaving
 * exactly as it did: a teacher who never configures anything has no rows here,
 * this returns null on the first query, and the metadata is byte-identical to
 * what it was.
 *
 * ONE query. Wrapped in React.cache for the same reason getTeacherBySlug is:
 * /b/[slug] is the app's primary acquisition surface, and generateMetadata can
 * be invoked more than once for a request.
 */
export const resolveSocialPreview = cache(
  async (teacherId: string, utmContent: string | null): Promise<ResolvedSocialPreview | null> => {
    const rows = await prisma.socialPreview.findMany({
      where: { teacherId },
      select: {
        id: true,
        shareGroupId: true,
        caption: true,
        updatedAt: true,
        shareGroup: { select: { id: true, name: true } },
        image: { select: { angle: true, source: true } },
      },
    });
    // The overwhelmingly common case, and the reason this costs one cheap
    // indexed query rather than a join against the teacher's group list.
    if (rows.length === 0) return null;

    const groupRows = rows.filter((r) => r.shareGroup !== null);
    const matched = matchShareGroupBySlug(
      groupRows.map((r) => r.shareGroup!),
      utmContent,
    );

    const chosen =
      (matched ? groupRows.find((r) => r.shareGroupId === matched.id) : undefined) ??
      rows.find((r) => r.shareGroupId === null);
    if (!chosen) return null;

    return {
      id: chosen.id,
      caption: chosen.caption,
      cardUrl: socialPreviewCardUrl(chosen.id, chosen.updatedAt),
      angle: chosen.image.angle,
      source: chosen.image.source,
      shareGroupSlug: chosen.shareGroup ? shareGroupSlug(chosen.shareGroup) : null,
    };
  },
);

/** The row the composed-card route renders from. Public data only — the same
 * teacher fields the booking page already exposes. */
export function findSocialPreviewForCard(previewId: string) {
  return prisma.socialPreview.findUnique({
    where: { id: previewId },
    select: {
      caption: true,
      image: { select: { storagePath: true, angle: true } },
      teacher: {
        select: {
          name: true,
          bio: true,
          photoPath: true,
          onboardingCompleteAt: true,
          disabledAt: true,
          templatesTouchedAt: true,
          availabilityTouchedAt: true,
          stripeChargesEnabled: true,
          pricingCurrency: true,
          payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
        },
      },
    },
  });
}
