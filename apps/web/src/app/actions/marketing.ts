"use server";

import { z } from "zod";
import {
  isMarketingContentKind,
  isMarketingPlatform,
  MARKETING_PLATFORMS,
  PROMO_POLICIES,
  type MarketingPlatform,
  type PromoPolicy,
  usesEnglishCopy,
} from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import {
  createActivity,
  getOrCreateCommunityDraft,
  markActivityDone,
  prepareActivity,
  skipActivity,
  updateActivityBody,
} from "@/lib/marketing/activities";
import {
  addCommunity,
  archiveCommunity,
  communityInputSchema,
  deleteCommunity,
  restoreCommunity,
  updateCommunity,
} from "@/lib/marketing/communities";
import { regenerateWeeklyPlan } from "@/lib/marketing/plan";
import {
  marketingProfileInputSchema,
  memeSettingsInputSchema,
  saveMarketingProfile,
  saveMemeSettings,
} from "@/lib/marketing/profile";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { revalidateAfterAction } from "@/lib/revalidate";

// Server actions for the Get Students surface (D-125).
//
// Every one of these re-resolves the signed-in teacher and scopes the write to
// her id — an activity id or community id from the client is never trusted as
// proof of ownership. The domain rules live in lib/marketing/*, so no caller
// can drift.

const GET_STUDENTS_PATH = "/dashboard/get-students";

export type MarketingState = { error?: string; ok?: boolean } | undefined;

function failed(en: boolean): MarketingState {
  return { error: en ? "That didn't work. Try again." : "No se pudo. Inténtalo otra vez." };
}

// ── Communities ────────────────────────────────────────────────────────────

const platformField = z
  .enum(MARKETING_PLATFORMS as unknown as [MarketingPlatform, ...MarketingPlatform[]])
  .optional();
const policyField = z.enum(PROMO_POLICIES as unknown as [PromoPolicy, ...PromoPolicy[]]).optional();

/** A field the form didn't render at all reads as null; the schema's optional
 * branches accept `undefined`, not `null`. Normalise here so a partial form
 * (an older mobile build, a narrower edit form) degrades to "unchanged" rather
 * than to a validation error the teacher can't act on. */
function optionalField(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw : undefined;
}

/** Checkbox groups post one entry per checked box, and nothing at all when
 * every box is cleared. A form that RENDERED the group therefore has to say so
 * explicitly (a hidden marker field), or "she unchecked every day" would be
 * indistinguishable from "this form has no day picker" — and the second must
 * leave the stored days alone. */
function weekdaysFromForm(formData: FormData): number[] | undefined {
  if (formData.get("promoRulesPresent") !== "1") return undefined;
  return formData.getAll("promoWeekdays").flatMap((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? [n] : [];
  });
}

/** A number field the browser posts as a string, and posts as "" when she
 * clears it. Empty means "no frequency rule" — which is `null`, an explicit
 * value the store writes, not `undefined`, which means "the form didn't ask". */
function numberFromForm(formData: FormData, key: string): number | null | undefined {
  const raw = formData.get(key);
  if (typeof raw !== "string") return undefined;
  if (raw.trim().length === 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function communityFromForm(formData: FormData) {
  return communityInputSchema.safeParse({
    name: formData.get("name"),
    url: optionalField(formData, "url"),
    // An unrecognised platform or policy is dropped rather than rejected: the
    // store then applies the platform's own conservative default, which is
    // never more permissive than what she asked for.
    platform: platformField.safeParse(formData.get("platform")).data,
    promoPolicy: policyField.safeParse(formData.get("promoPolicy")).data,
    audienceNote: optionalField(formData, "audienceNote"),
    promoWeekdays: weekdaysFromForm(formData),
    promoEveryDays: numberFromForm(formData, "promoEveryDays"),
    promoLinksAllowed: z.enum(["default", "yes", "no"]).safeParse(formData.get("promoLinksAllowed"))
      .data,
    promoNotes: optionalField(formData, "promoNotes"),
    memeBrief: optionalField(formData, "memeBrief"),
  });
}

export async function addCommunityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const parsed = communityFromForm(formData);
  if (!parsed.success) {
    return {
      error: en
        ? "Add a name (and a valid link, if you include one)."
        : "Agrega un nombre (y un enlace válido, si lo incluyes).",
    };
  }
  const teacher = await requireOnboardedTeacher();
  await addCommunity(teacher.id, parsed.data);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

export async function updateCommunityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  const parsed = communityFromForm(formData);
  if (!id.success || !parsed.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await updateCommunity(teacher.id, id.data, parsed.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

export async function archiveCommunityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  // Archive, never delete: the community's historical results are what the
  // planner ranks by, and deleting a row silently rewrites her own history.
  const ok = await archiveCommunity(teacher.id, id.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

export async function restoreCommunityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await restoreCommunity(teacher.id, id.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

export async function deleteCommunityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await deleteCommunity(teacher.id, id.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

// ── Marketing profile ──────────────────────────────────────────────────────

/** Comma-separated free text into a bounded list. */
function listFromForm(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 6);
}

export async function saveMarketingProfileAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const parsed = marketingProfileInputSchema.safeParse({
    audiences: listFromForm(formData.get("audiences")),
    learnerLocations: listFromForm(formData.get("learnerLocations")),
    levels: listFromForm(formData.get("levels")),
    differentiator: formData.get("differentiator"),
    weeklyMinutes: formData.get("weeklyMinutes"),
    goalNewStudentsPerMonth: formData.get("goalNewStudentsPerMonth"),
  });
  if (!parsed.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  await saveMarketingProfile(teacher.id, parsed.data);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/profile`);
  return { ok: true };
}

// ── Activities ─────────────────────────────────────────────────────────────

export type PrepareState = { error?: string; ok?: boolean; reason?: string } | undefined;

export async function prepareActivityAction(
  _prev: PrepareState,
  formData: FormData,
): Promise<PrepareState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const entitlements = await loadEntitlements(teacher.id);
  const topic = formData.get("topic");
  const sourcePost = formData.get("sourcePost");
  const result = await prepareActivity({
    teacherId: teacher.id,
    activityId: id.data,
    isPro: entitlements.isPro,
    topic: typeof topic === "string" && topic.trim() ? topic.trim().slice(0, 300) : null,
    sourcePost:
      typeof sourcePost === "string" && sourcePost.trim() ? sourcePost.trim().slice(0, 2000) : null,
  });
  revalidateAfterAction(`${GET_STUDENTS_PATH}/${id.data}`);
  if (!result.ok) return { error: result.reason, reason: result.reason };
  return { ok: true };
}

export async function markActivityDoneAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await markActivityDone(teacher.id, id.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/${id.data}`);
  return { ok: true };
}

export async function skipActivityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await skipActivity(teacher.id, id.data);
  if (!ok) return failed(en);
  revalidateAfterAction(GET_STUDENTS_PATH);
  return { ok: true };
}

export async function saveActivityBodyAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const id = z.string().uuid().safeParse(formData.get("id"));
  const body = z.string().trim().min(1).max(5000).safeParse(formData.get("body"));
  if (!id.success || !body.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const ok = await updateActivityBody(teacher.id, id.data, body.data);
  if (!ok) return failed(en);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/${id.data}`);
  return { ok: true };
}

export async function regeneratePlanAction(
  _prev: MarketingState,
  _formData: FormData,
): Promise<MarketingState> {
  const teacher = await requireOnboardedTeacher();
  await regenerateWeeklyPlan({ teacherId: teacher.id });
  revalidateAfterAction(GET_STUDENTS_PATH);
  return { ok: true };
}

/** Ad-hoc extra action, outside the week's plan. */
export async function addActivityAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const kind = formData.get("kind");
  const platform = formData.get("platform");
  const communityId = formData.get("communityId");
  if (!isMarketingContentKind(kind) || !isMarketingPlatform(platform)) return failed(en);
  const teacher = await requireOnboardedTeacher();
  const parsedCommunity = z.string().uuid().safeParse(communityId);
  await createActivity({
    teacherId: teacher.id,
    kind,
    platform,
    communityId: parsedCommunity.success ? parsedCommunity.data : null,
  });
  revalidateAfterAction(GET_STUDENTS_PATH);
  return { ok: true };
}

// ── Image preferences ──────────────────────────────────────────────────────

/**
 * Her general, reusable image instructions.
 *
 * Its own action rather than a branch of saveMarketingProfileAction, because
 * the two are edited from different screens and a shared handler would let
 * either form blank the other's fields on submit.
 */
export async function saveMemeSettingsAction(
  _prev: MarketingState,
  formData: FormData,
): Promise<MarketingState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const parsed = memeSettingsInputSchema.safeParse({
    memeBrief: optionalField(formData, "memeBrief") ?? "",
    memeStyle: optionalField(formData, "memeStyle"),
  });
  if (!parsed.success) return failed(en);
  const teacher = await requireOnboardedTeacher();
  await saveMemeSettings(teacher.id, parsed.data);
  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  return { ok: true };
}

// ── A post for one community ───────────────────────────────────────────────

/**
 * Write (or rewrite) the post for one community, in place on the Communities
 * page.
 *
 * This is deliberately NOT a second content pipeline. It resolves the
 * community's one live draft — a MarketingActivity, the same entity the weekly
 * plan and the results screen already use — and runs the same
 * `prepareActivity` the plan runs. What is new is only the entry point: she can
 * now start from the community she is thinking about rather than from a
 * generated week.
 */
export async function generateCommunityPostAction(
  _prev: PrepareState,
  formData: FormData,
): Promise<PrepareState> {
  const en = usesEnglishCopy(await getPreferredLocale());
  const communityId = z.string().uuid().safeParse(formData.get("communityId"));
  const kind = formData.get("kind");
  const platform = formData.get("platform");
  if (!communityId.success || !isMarketingContentKind(kind) || !isMarketingPlatform(platform)) {
    return failed(en);
  }

  const teacher = await requireOnboardedTeacher();
  const draft = await getOrCreateCommunityDraft({
    teacherId: teacher.id,
    communityId: communityId.data,
    kind,
    platform,
  });
  // Null means the community is not hers (or is gone). Same message either
  // way, so an id cannot be probed from the outside.
  if (!draft) return failed(en);

  const entitlements = await loadEntitlements(teacher.id);
  const topic = formData.get("topic");
  const result = await prepareActivity({
    teacherId: teacher.id,
    activityId: draft.activityId,
    isPro: entitlements.isPro,
    topic: typeof topic === "string" && topic.trim() ? topic.trim().slice(0, 300) : null,
    // The image is generated from the meme panel, deliberately: one Generate
    // button must cost one provider call, and bundling an image into the post
    // button would spend an allowance unit she did not ask to spend.
    withImage: false,
  });

  revalidateAfterAction(`${GET_STUDENTS_PATH}/communities`);
  if (!result.ok) return { error: result.reason, reason: result.reason };
  return { ok: true };
}
