import { z } from "zod";
import {
  COMMUNITY_MEME_BRIEF_MAX_CHARS,
  DEFAULT_PROMOTION_RULES,
  isMarketingPlatform,
  isPromoPolicy,
  MARKETING_PLATFORMS,
  normalizeEveryDays,
  normalizeWeekdays,
  PLATFORM_SPECS,
  PROMO_NOTES_MAX_CHARS,
  PROMO_POLICIES,
  type MarketingPlatform,
  type PromoPolicy,
  type PromotionRules,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// Marketing communities — the generalised successor to "the Facebook groups a
// teacher posts her link in" (D-125). Same table (`teacher_share_groups`), same
// ids, same already-posted utm_content slugs; a platform, a promotion policy
// and an audience note on top.
//
// This module supersedes lib/share-groups/store.ts, which now re-exports from
// here so every existing caller (the social-preview panel, the growth
// checklist) keeps working unchanged.

export const COMMUNITY_NAME_MAX = 80;
export const COMMUNITY_URL_MAX = 300;
export const COMMUNITY_AUDIENCE_MAX = 160;

/** Empty string clears the column; anything longer than `max` is rejected
 * rather than silently truncated, so what she reads back is what she typed.
 * Ordering matters: `.optional()` first would accept "" as a valid string and
 * never reach the transform. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? undefined : v))
    .pipe(z.string().max(max).optional())
    .optional();
}

/**
 * The same, for a field that must be able to be CLEARED.
 *
 * The difference is the whole point: `optionalText` collapses "" to undefined,
 * and `promotionData` below reads undefined as "this form did not render the
 * field, leave the stored value alone". For a field the store treats that way,
 * collapsing would make emptying the textarea a no-op — she would delete her
 * note, save, and find it still there. So "" survives as "", meaning present
 * and empty, and only a genuinely absent key is left untouched.
 */
function clearableText(max: number) {
  return z.string().trim().max(max).optional();
}

export const communityInputSchema = z.object({
  name: z.string().trim().min(1).max(COMMUNITY_NAME_MAX),
  url: z
    .string()
    .trim()
    .max(COMMUNITY_URL_MAX)
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  platform: z
    .enum(MARKETING_PLATFORMS as unknown as [MarketingPlatform, ...MarketingPlatform[]])
    .optional(),
  promoPolicy: z.enum(PROMO_POLICIES as unknown as [PromoPolicy, ...PromoPolicy[]]).optional(),
  // Same ordering as the differentiator in lib/marketing/profile: empty maps to
  // undefined before the length check, so clearing the input clears the field.
  audienceNote: optionalText(COMMUNITY_AUDIENCE_MAX),
  // --- What "limited" means here. Every field is optional, and a form that
  // omits all of them leaves the stored rules exactly as they were. ---
  //
  // These describe the SHAPE only; the meaning-preserving normalisation (dedupe
  // and range the days, floor the frequency) happens in `promotionData` below,
  // which is the last thing before the write and therefore the only place that
  // can guarantee it. Keeping the schema free of transforms also keeps its
  // input and output types identical, which is what `readJsonBody` requires of
  // a ZodSchema.
  promoWeekdays: z.array(z.number().int()).optional(),
  // Null and 0 both mean "no frequency rule" — clearing the field is a
  // legitimate edit, not a validation failure.
  promoEveryDays: z.number().int().nullable().optional(),
  promoLinksAllowed: z.enum(["default", "yes", "no"]).optional(),
  promoNotes: clearableText(PROMO_NOTES_MAX_CHARS),
  memeBrief: clearableText(COMMUNITY_MEME_BRIEF_MAX_CHARS),
});

export type CommunityInput = z.infer<typeof communityInputSchema>;

export type CommunityView = {
  id: string;
  name: string;
  url: string | null;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  audienceNote: string | null;
  /** The structured + free-text specifics of a `limited` policy. Always
   * present (defaults, never null) so no caller has to branch on absence. */
  rules: PromotionRules;
  /** Community-specific image instructions, layered on the teacher's own. */
  memeBrief: string | null;
  archived: boolean;
};

const SELECT = {
  id: true,
  name: true,
  url: true,
  platform: true,
  promoPolicy: true,
  audienceNote: true,
  promoWeekdays: true,
  promoEveryDays: true,
  promoLinksAllowed: true,
  promoNotes: true,
  memeBrief: true,
  archivedAt: true,
} as const;

type Row = {
  id: string;
  name: string;
  url: string | null;
  platform: string;
  promoPolicy: string;
  audienceNote: string | null;
  promoWeekdays: number[];
  promoEveryDays: number | null;
  promoLinksAllowed: boolean | null;
  promoNotes: string | null;
  memeBrief: string | null;
  archivedAt: Date | null;
};

/**
 * Rows carry app-validated strings, not DB enums (same posture as
 * `pricing_currency`), so a value written by a newer deploy and read by an
 * older one degrades to the safe default rather than throwing.
 */
export function toCommunityView(row: Row): CommunityView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    platform: isMarketingPlatform(row.platform) ? row.platform : "other",
    promoPolicy: isPromoPolicy(row.promoPolicy) ? row.promoPolicy : "unknown",
    audienceNote: row.audienceNote,
    rules: {
      ...DEFAULT_PROMOTION_RULES,
      weekdays: normalizeWeekdays(row.promoWeekdays),
      everyDays: normalizeEveryDays(row.promoEveryDays),
      linksAllowed: row.promoLinksAllowed,
      notes: row.promoNotes,
    },
    memeBrief: row.memeBrief,
    archived: row.archivedAt !== null,
  };
}

/** The tri-state link override as the form spells it. `undefined` (the field
 * was not rendered at all) leaves the column untouched; every other value is
 * an explicit answer, including "back to the platform default". */
function linkOverride(value: "default" | "yes" | "no" | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/** Only the promotion fields the form actually rendered. Written as a partial
 * so a narrower client (an older mobile build, the quick-add form) can never
 * blank a rule it did not know about. */
function promotionData(input: CommunityInput) {
  const links = linkOverride(input.promoLinksAllowed);
  return {
    ...(input.promoWeekdays !== undefined
      ? { promoWeekdays: normalizeWeekdays(input.promoWeekdays) }
      : {}),
    ...(input.promoEveryDays !== undefined
      ? { promoEveryDays: normalizeEveryDays(input.promoEveryDays) }
      : {}),
    ...(links !== undefined ? { promoLinksAllowed: links } : {}),
    ...(input.promoNotes !== undefined ? { promoNotes: input.promoNotes || null } : {}),
    ...(input.memeBrief !== undefined ? { memeBrief: input.memeBrief || null } : {}),
  };
}

/** A teacher's live communities, in display order. */
export async function listCommunities(
  teacherId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<CommunityView[]> {
  const rows = await prisma.teacherShareGroup.findMany({
    where: { teacherId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: SELECT,
  });
  return rows.map(toCommunityView);
}

/** One community, ownership-scoped. Returns null for another teacher's id
 * rather than throwing, so a caller can treat "not yours" and "gone" alike —
 * which is what stops an id from being probeable. */
export async function getCommunity(teacherId: string, id: string): Promise<CommunityView | null> {
  const row = await prisma.teacherShareGroup.findFirst({
    where: { id, teacherId },
    select: SELECT,
  });
  return row ? toCommunityView(row) : null;
}

export function countCommunities(teacherId: string): Promise<number> {
  return prisma.teacherShareGroup.count({ where: { teacherId, archivedAt: null } });
}

export async function addCommunity(
  teacherId: string,
  input: CommunityInput,
): Promise<CommunityView> {
  const last = await prisma.teacherShareGroup.findFirst({
    where: { teacherId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const platform = input.platform ?? "facebook_group";
  const row = await prisma.teacherShareGroup.create({
    data: {
      teacherId,
      name: input.name,
      url: input.url ?? null,
      platform,
      // A teacher who hasn't stated the community's rules inherits the
      // PLATFORM's conservative default rather than "open" — Reddit starts
      // prohibited, Facebook limited. She can only ever loosen it deliberately.
      promoPolicy: input.promoPolicy ?? PLATFORM_SPECS[platform].defaultPromoPolicy,
      audienceNote: input.audienceNote ?? null,
      ...promotionData(input),
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
    select: SELECT,
  });
  return toCommunityView(row);
}

export async function updateCommunity(
  teacherId: string,
  id: string,
  input: CommunityInput,
): Promise<boolean> {
  const updated = await prisma.teacherShareGroup.updateMany({
    where: { id, teacherId },
    data: {
      name: input.name,
      url: input.url ?? null,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.promoPolicy ? { promoPolicy: input.promoPolicy } : {}),
      audienceNote: input.audienceNote ?? null,
      ...promotionData(input),
    },
  });
  return updated.count > 0;
}

/**
 * Archive rather than delete by default: a deleted community takes its
 * historical acquisition results with it (the ledger's FK is SET NULL), and
 * "which group won me that student last spring" is exactly the question this
 * whole system exists to answer.
 */
export async function archiveCommunity(teacherId: string, id: string): Promise<boolean> {
  const updated = await prisma.teacherShareGroup.updateMany({
    where: { id, teacherId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  return updated.count > 0;
}

export async function restoreCommunity(teacherId: string, id: string): Promise<boolean> {
  const updated = await prisma.teacherShareGroup.updateMany({
    where: { id, teacherId, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  return updated.count > 0;
}

/** Hard delete, kept for the teacher who genuinely added a wrong row. */
export async function deleteCommunity(teacherId: string, id: string): Promise<boolean> {
  const deleted = await prisma.teacherShareGroup.deleteMany({ where: { id, teacherId } });
  return deleted.count > 0;
}
