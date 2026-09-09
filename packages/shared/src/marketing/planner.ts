// The weekly plan generator.
//
// This is the piece that answers "what should I do today?", and it is
// DELIBERATELY NOT an AI call. The model writes the words; this decides the
// work — how many actions fit the teacher's week, which communities get them,
// which content kind goes where, and why. Three reasons that split matters:
//
//   * It is testable. A plan is a pure function of signals, so "does it ever
//     schedule a promotional post in a no-promotion community" is a unit test,
//     not a prompt-engineering hope.
//   * It cannot fabricate. Every reason a teacher reads is derived from a
//     number we actually hold, not from a model's impression of one.
//   * It is cheap and instant. Regenerating a plan costs nothing, so the plan
//     can adapt on every result without a token budget conversation.
//
// The plan adapts through `PlannerCommunity.students/enquiries/visits`, which
// come from the acquisition ledger. With no data it falls back to
// explore-everything; with data it concentrates on what works while still
// spending one slot on something untried.

import type { AppLocale } from "../i18n/locales";
import { allowsDirectPromotion, type MarketingPlatform, type PromoPolicy } from "./channels";
import {
  CONTENT_KIND_SPECS,
  eligibleContentKinds,
  type ContentCapabilities,
  type MarketingContentKind,
} from "./content-kinds";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes a teacher should expect one prepared community post to cost her. */
export const MINUTES_PER_ACTION = 12;

/**
 * A referral ask is four lines of WhatsApp to someone she already teaches, so
 * it does not cost what a community post costs.
 *
 * Exported alongside `estimatedMinutesFor` because the plan is not the only
 * thing that totals these minutes: the weekly screen totals them too, and it
 * did so with its own hardcoded 12 — over-stating every week that contained a
 * referral ask, which is the cheapest action the planner can schedule and the
 * one it puts first.
 */
export const REFERRAL_ASK_MINUTES = 5;

/** What one action of this kind should cost her, in minutes. */
export function estimatedMinutesFor(kind: MarketingContentKind): number {
  return kind === "referral_ask" ? REFERRAL_ASK_MINUTES : MINUTES_PER_ACTION;
}

/** Default weekly time budget when the teacher has not said otherwise. */
export const DEFAULT_WEEKLY_MINUTES = 60;

export const MIN_ACTIONS_PER_WEEK = 2;
export const MAX_ACTIONS_PER_WEEK = 7;

/** Don't post to the same community more often than this. */
const COMMUNITY_COOLDOWN_DAYS = 5;

/** Don't repeat a content kind in the same community inside this window. */
const KIND_REPEAT_WINDOW_DAYS = 21;

/** At most one promotional action per this many actions. */
const PROMO_EVERY_N = 3;

export type PlannerCommunity = {
  id: string;
  name: string;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  /** Null when nothing has ever been posted here through the app. */
  lastActivityAt: Date | null;
  /** Observed results attributed to this community, all-time. */
  visits: number;
  enquiries: number;
  students: number;
};

export type ReferralCandidate = {
  studentId: string;
  studentName: string;
  /** Why this student is a good moment to ask. */
  trigger: "first_lesson" | "package_complete" | "renewal" | "testimonial";
};

export type PastActivity = {
  kind: MarketingContentKind;
  communityId: string | null;
  at: Date;
};

export type PlannerSignals = {
  communities: readonly PlannerCommunity[];
  capabilities: ContentCapabilities;
  referralCandidates: readonly ReferralCandidate[];
  recentActivities: readonly PastActivity[];
  /** Teacher's stated weekly budget in minutes. */
  weeklyMinutes: number;
  now: Date;
};

/**
 * Why an action is in the plan. Structured rather than prose so the same plan
 * renders in any locale, and so a reason can never be a sentence the model
 * invented — every field below is a number or name we hold.
 */
export type PlanReason =
  | { code: "best_community"; community: string; students: number }
  | { code: "promising_community"; community: string; enquiries: number }
  | { code: "quiet_community"; community: string; days: number }
  | { code: "untried_community"; community: string }
  | { code: "educational_first"; community: string }
  | { code: "referral_moment"; student: string; trigger: ReferralCandidate["trigger"] }
  | { code: "no_communities" };

export type PlannedAction = {
  /** 1-based position in the week. Lower is more important. */
  slot: number;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  communityId: string | null;
  /** Set only for referral actions. */
  studentId: string | null;
  reason: PlanReason;
  estimatedMinutes: number;
};

export type WeeklyPlan = {
  weekStart: Date;
  actions: PlannedAction[];
  totalMinutes: number;
};

/** Monday 00:00 UTC of the week containing `now`. */
export function weekStartOf(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const offset = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - offset * DAY_MS);
}

export function actionsForBudget(weeklyMinutes: number): number {
  const raw = Math.round(weeklyMinutes / MINUTES_PER_ACTION);
  return Math.min(MAX_ACTIONS_PER_WEEK, Math.max(MIN_ACTIONS_PER_WEEK, raw));
}

function daysSince(from: Date | null, now: Date): number {
  if (!from) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Community ranking. Proven results dominate; among unproven ones, the least
 * recently used wins, which is what makes a brand-new community get a turn
 * instead of being starved by the one that already has a single lucky visit.
 */
function communityScore(c: PlannerCommunity, now: Date): number {
  const proven = c.students * 1000 + c.enquiries * 100 + Math.min(c.visits, 50);
  const staleness = Math.min(daysSince(c.lastActivityAt, now), 60);
  // Never-used communities get the full staleness bonus, so exploration is
  // built in rather than bolted on.
  return proven + staleness;
}

function reasonFor(c: PlannerCommunity, now: Date, promotional: boolean): PlanReason {
  if (c.students > 0) return { code: "best_community", community: c.name, students: c.students };
  if (c.enquiries > 0) {
    return { code: "promising_community", community: c.name, enquiries: c.enquiries };
  }
  if (!c.lastActivityAt) return { code: "untried_community", community: c.name };
  const days = daysSince(c.lastActivityAt, now);
  if (days >= COMMUNITY_COOLDOWN_DAYS * 2) {
    return { code: "quiet_community", community: c.name, days };
  }
  return promotional
    ? { code: "quiet_community", community: c.name, days }
    : { code: "educational_first", community: c.name };
}

/**
 * Deterministic rotation index. Same inputs always produce the same plan, so a
 * regenerate is idempotent and a test can assert an exact plan — but different
 * communities and different weeks rotate to different content kinds, so the
 * teacher isn't handed the same tip four weeks running.
 */
function rotationIndex(seed: string, span: number): number {
  if (span <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % span;
}

function pickKind(input: {
  community: PlannerCommunity;
  capabilities: ContentCapabilities;
  allowPromotional: boolean;
  recentActivities: readonly PastActivity[];
  now: Date;
  weekSeed: string;
}): MarketingContentKind | null {
  const eligible = eligibleContentKinds({
    platform: input.community.platform,
    promoPolicy: input.community.promoPolicy,
    capabilities: input.capabilities,
  }).filter((k) => k !== "referral_ask");
  if (eligible.length === 0) return null;

  const promoAllowedHere =
    input.allowPromotional && allowsDirectPromotion(input.community.promoPolicy);
  const pool = eligible.filter((k) => promoAllowedHere || !CONTENT_KIND_SPECS[k].promotional);
  const candidates =
    pool.length > 0 ? pool : eligible.filter((k) => !CONTENT_KIND_SPECS[k].promotional);
  if (candidates.length === 0) return null;

  // When promotion is allowed for this slot, prefer a promotional kind — the
  // slot was rationed for exactly that.
  const preferred = promoAllowedHere
    ? candidates.filter((k) => CONTENT_KIND_SPECS[k].promotional)
    : candidates.filter((k) => !CONTENT_KIND_SPECS[k].promotional);
  const ranked = preferred.length > 0 ? preferred : candidates;

  const cutoff = new Date(input.now.getTime() - KIND_REPEAT_WINDOW_DAYS * DAY_MS);
  const usedHere = new Set(
    input.recentActivities
      .filter((a) => a.communityId === input.community.id && a.at >= cutoff)
      .map((a) => a.kind),
  );
  const fresh = ranked.filter((k) => !usedHere.has(k));
  const finalPool = fresh.length > 0 ? fresh : ranked;
  return finalPool[rotationIndex(`${input.weekSeed}:${input.community.id}`, finalPool.length)];
}

/**
 * Build the week's plan.
 *
 * Ordering intent: the highest-confidence action first, so a teacher who only
 * ever does the top item is still doing the best available thing.
 */
export function buildWeeklyPlan(signals: PlannerSignals): WeeklyPlan {
  const weekStart = weekStartOf(signals.now);
  const weekSeed = weekStart.toISOString().slice(0, 10);
  const budget = actionsForBudget(signals.weeklyMinutes);
  const actions: PlannedAction[] = [];

  // A referral ask leads whenever there is a real moment for one: it is the
  // cheapest action in the plan and converts far better than any cold post.
  const referral = signals.referralCandidates[0];
  if (referral && signals.capabilities.hasStudents) {
    actions.push({
      slot: 1,
      kind: "referral_ask",
      platform: "whatsapp",
      communityId: null,
      studentId: referral.studentId,
      reason: {
        code: "referral_moment",
        student: referral.studentName,
        trigger: referral.trigger,
      },
      estimatedMinutes: estimatedMinutesFor("referral_ask"),
    });
  }

  const active = signals.communities.filter((c) => {
    const days = daysSince(c.lastActivityAt, signals.now);
    return days >= COMMUNITY_COOLDOWN_DAYS;
  });
  const pool = (active.length > 0 ? active : signals.communities)
    .slice()
    .sort((a, b) => communityScore(b, signals.now) - communityScore(a, signals.now));

  if (pool.length === 0) {
    // Nothing to post into. Say so honestly rather than inventing a channel —
    // the UI turns this into "add your first community", which is the real
    // next action.
    return { weekStart, actions, totalMinutes: totalMinutes(actions) };
  }

  let promoUsed = 0;
  let index = 0;
  while (actions.length < budget) {
    const community = pool[index % pool.length];
    index += 1;
    // Round-robin the pool; stop once every community has had a fair pass and
    // we still cannot fill the budget, rather than spinning.
    if (index > pool.length * 3) break;

    const postsSoFar = actions.filter((a) => a.communityId !== null).length;
    const allowPromotional = promoUsed * PROMO_EVERY_N <= postsSoFar;
    const kind = pickKind({
      community,
      capabilities: signals.capabilities,
      allowPromotional,
      recentActivities: signals.recentActivities,
      now: signals.now,
      weekSeed,
    });
    if (!kind) continue;

    const promotional = CONTENT_KIND_SPECS[kind].promotional;
    if (promotional) promoUsed += 1;

    actions.push({
      slot: actions.length + 1,
      kind,
      platform: community.platform,
      communityId: community.id,
      studentId: null,
      reason: reasonFor(community, signals.now, promotional),
      estimatedMinutes: estimatedMinutesFor(kind),
    });
  }

  // Renumber so slots stay contiguous after any skipped community.
  actions.forEach((a, i) => {
    a.slot = i + 1;
  });

  return { weekStart, actions, totalMinutes: totalMinutes(actions) };
}

function totalMinutes(actions: readonly PlannedAction[]): number {
  return actions.reduce((sum, a) => sum + a.estimatedMinutes, 0);
}

// ── Progress through the week ──────────────────────────────────────────────

/**
 * The status of one activity, as the plan's own vocabulary rather than
 * Prisma's.
 *
 * Named `PlanActivityStatus` and not `MarketingActivityStatus` on purpose: the
 * generated Prisma enum already owns that name, and a second export of it from
 * this package would collide in every module that imports both.
 */
export type PlanActivityStatus = "planned" | "ready" | "done" | "skipped";

export type PlanProgress = {
  /** Actions still counted toward this week — done plus open, never skipped. */
  total: number;
  done: number;
  skipped: number;
  remaining: number;
  /** `done / total`, clamped to 0 when nothing is planned. */
  fraction: number;
  /** Minutes the open actions should still cost her. */
  minutesLeft: number;
  /** Something was planned, and none of it is still open. */
  complete: boolean;
};

/**
 * How far through her week she is.
 *
 * A SKIPPED action leaves the denominator rather than counting as unfinished.
 * Skipping is a decision — "not this one, not this week" — so a teacher who
 * skips two of six should be able to reach the end of her week, and a meter
 * that can never fill teaches her that skipping is a failure state. It is not;
 * the planner explicitly expects to be over-ruled.
 *
 * Pure, and here rather than in the screen, for the reason the planner itself
 * is: the numbers a teacher reads should be derivable from a test.
 */
export function planProgress(
  items: readonly { kind: MarketingContentKind; status: PlanActivityStatus }[],
): PlanProgress {
  const open = items.filter((i) => i.status === "planned" || i.status === "ready");
  const done = items.filter((i) => i.status === "done").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const total = open.length + done;
  return {
    total,
    done,
    skipped,
    remaining: open.length,
    fraction: total === 0 ? 0 : done / total,
    minutesLeft: open.reduce((sum, i) => sum + estimatedMinutesFor(i.kind), 0),
    complete: total > 0 && open.length === 0,
  };
}

// ── Reason rendering ───────────────────────────────────────────────────────

const TRIGGER_TEXT: Record<ReferralCandidate["trigger"], Record<AppLocale, string>> = {
  first_lesson: {
    "es-MX": "acaba de tomar su primera clase",
    en: "just had their first lesson",
    fr: "vient de suivre son premier cours",
  },
  package_complete: {
    "es-MX": "terminó su paquete",
    en: "finished their package",
    fr: "a terminé son forfait",
  },
  renewal: {
    "es-MX": "renovó su paquete",
    en: "renewed their package",
    fr: "a renouvelé son forfait",
  },
  testimonial: {
    "es-MX": "te dejó una reseña",
    en: "left you a testimonial",
    fr: "vous a laissé un témoignage",
  },
};

/** One sentence explaining why this action is in the plan. */
export function planReasonText(reason: PlanReason, locale: AppLocale): string {
  switch (reason.code) {
    case "best_community":
      return locale === "es-MX"
        ? `${reason.community} ya te trajo ${reason.students} alumno${reason.students === 1 ? "" : "s"}.`
        : locale === "fr"
          ? `${reason.community} vous a déjà amené ${reason.students} élève${reason.students === 1 ? "" : "s"}.`
          : `${reason.community} has already brought you ${reason.students} student${reason.students === 1 ? "" : "s"}.`;
    case "promising_community":
      return locale === "es-MX"
        ? `${reason.community} generó ${reason.enquiries} mensaje${reason.enquiries === 1 ? "" : "s"} de interesados.`
        : locale === "fr"
          ? `${reason.community} a généré ${reason.enquiries} demande${reason.enquiries === 1 ? "" : "s"}.`
          : `${reason.community} produced ${reason.enquiries} enquir${reason.enquiries === 1 ? "y" : "ies"}.`;
    case "quiet_community":
      return locale === "es-MX"
        ? `No publicas en ${reason.community} desde hace ${reason.days} días.`
        : locale === "fr"
          ? `Vous n'avez rien publié dans ${reason.community} depuis ${reason.days} jours.`
          : `You haven't posted in ${reason.community} for ${reason.days} days.`;
    case "untried_community":
      return locale === "es-MX"
        ? `Todavía no pruebas ${reason.community}. Vale la pena ver qué pasa.`
        : locale === "fr"
          ? `Vous n'avez pas encore essayé ${reason.community}. Cela vaut la peine de voir.`
          : `You haven't tried ${reason.community} yet — worth seeing what happens.`;
    case "educational_first":
      return locale === "es-MX"
        ? `En ${reason.community} algo útil funciona mejor que un anuncio.`
        : locale === "fr"
          ? `Dans ${reason.community}, un contenu utile marche mieux qu'une annonce.`
          : `In ${reason.community}, something useful lands better than an ad.`;
    case "referral_moment":
      return locale === "es-MX"
        ? `${reason.student} ${TRIGGER_TEXT[reason.trigger]["es-MX"]}. Es el mejor momento para pedir una recomendación.`
        : locale === "fr"
          ? `${reason.student} ${TRIGGER_TEXT[reason.trigger].fr}. C'est le meilleur moment pour demander une recommandation.`
          : `${reason.student} ${TRIGGER_TEXT[reason.trigger].en} — the best moment to ask for a referral.`;
    case "no_communities":
      return locale === "es-MX"
        ? "Agrega una comunidad para que podamos prepararte acciones."
        : locale === "fr"
          ? "Ajoutez une communauté pour que nous puissions préparer vos actions."
          : "Add a community so we can prepare actions for you.";
  }
}
