// The channel registry — the one place that knows what each acquisition
// platform IS, what it tolerates, and what a post for it has to look like.
//
// This exists because the single most common failure of "AI marketing" tooling
// is generating one blob of copy and pasting it everywhere. A Facebook group
// post and a Reddit comment are not the same artefact: the second one gets a
// teacher banned if it reads like the first. So platform rules are an INPUT to
// generation (they ride into the prompt) and a constraint on the UI (link
// placement, length, whether a direct offer is even allowed), rather than
// advice in a help article nobody reads.
//
// Shared between web and mobile so the two clients can never disagree about
// what is acceptable in a given community.

import type { AppLocale } from "../i18n/locales";

export type MarketingPlatform =
  "facebook_group" | "reddit" | "whatsapp" | "instagram" | "local" | "other";

export const MARKETING_PLATFORMS: readonly MarketingPlatform[] = [
  "facebook_group",
  "reddit",
  "whatsapp",
  "instagram",
  "local",
  "other",
] as const;

export function isMarketingPlatform(value: unknown): value is MarketingPlatform {
  return typeof value === "string" && (MARKETING_PLATFORMS as readonly string[]).includes(value);
}

/**
 * How much direct self-promotion a community tolerates.
 *
 * This is per-COMMUNITY (a teacher records what a given group's rules say),
 * with the platform default below as the starting point. It is the single most
 * load-bearing field in the whole system: it decides which content kinds the
 * planner is even allowed to schedule there, which is how "help teachers
 * market" stays distinct from "help teachers get banned".
 */
export type PromoPolicy = "open" | "limited" | "prohibited" | "unknown";

export const PROMO_POLICIES: readonly PromoPolicy[] = [
  "open",
  "limited",
  "prohibited",
  "unknown",
] as const;

export function isPromoPolicy(value: unknown): value is PromoPolicy {
  return typeof value === "string" && (PROMO_POLICIES as readonly string[]).includes(value);
}

/** Where a link may go in a post on this platform. */
export type LinkPlacement = "inline" | "profile_only" | "on_request";

export type PlatformSpec = {
  platform: MarketingPlatform;
  label: Record<AppLocale, string>;
  /** Starting point for a newly added community on this platform. */
  defaultPromoPolicy: PromoPolicy;
  /** Soft ceiling fed to the generator. Not enforced on the teacher's edits. */
  maxChars: number;
  /** Where a link belongs, in this platform's own culture. */
  linkPlacement: LinkPlacement;
  /** Aspect ratio a generated image should target here. */
  imageAspect: "1.91:1" | "1:1" | "4:5";
  /** Voice guidance, injected verbatim into the generation prompt. */
  voice: string;
  /**
   * Platform rules the generator must respect. These are OUR reading of each
   * platform's stated policy, written as instructions the model can follow.
   */
  rules: readonly string[];
};

export const PLATFORM_SPECS: Record<MarketingPlatform, PlatformSpec> = {
  facebook_group: {
    platform: "facebook_group",
    label: { "es-MX": "Grupo de Facebook", en: "Facebook group", fr: "Groupe Facebook" },
    defaultPromoPolicy: "limited",
    maxChars: 700,
    linkPlacement: "inline",
    imageAspect: "1.91:1",
    voice:
      "Warm, conversational, first person, like a neighbour talking to the group. Short paragraphs. No marketing slogans, no emoji spam, no ALL CAPS.",
    rules: [
      "Write as a member of the community, never as a brand.",
      "One link at most, and only when the community allows promotion.",
      "Never claim guaranteed results or fluency in a fixed number of weeks.",
    ],
  },
  reddit: {
    platform: "reddit",
    label: { "es-MX": "Comunidad de Reddit", en: "Reddit community", fr: "Communauté Reddit" },
    // Reddit's site-wide culture and most language subreddits treat unsolicited
    // self-promotion as spam. Default to the strictest reading and make the
    // teacher opt a community UP, never silently down.
    defaultPromoPolicy: "prohibited",
    maxChars: 1200,
    linkPlacement: "profile_only",
    imageAspect: "1:1",
    voice:
      "Genuinely helpful and specific, the way a knowledgeable person answers a question. Plain text, no formatting flourish, no sales language whatsoever.",
    rules: [
      "The comment must be useful on its own even if the reader never clicks anything.",
      "Do NOT include a booking link, a price, or an offer.",
      "Do NOT say 'I teach' more than once, and never open with it.",
      "Never write anything that reads as an advertisement — that is against site rules and gets the account banned.",
    ],
  },
  whatsapp: {
    platform: "whatsapp",
    label: { "es-MX": "WhatsApp", en: "WhatsApp", fr: "WhatsApp" },
    defaultPromoPolicy: "open",
    maxChars: 400,
    linkPlacement: "inline",
    imageAspect: "1:1",
    voice:
      "Personal and direct, addressed to one person the teacher already knows. Short. No formatting, no hashtags.",
    rules: [
      "Address one person, not a list.",
      "Never send to someone who has not already been in touch with the teacher.",
      "Keep it under four short lines.",
    ],
  },
  instagram: {
    platform: "instagram",
    label: { "es-MX": "Instagram", en: "Instagram", fr: "Instagram" },
    defaultPromoPolicy: "open",
    maxChars: 500,
    linkPlacement: "profile_only",
    imageAspect: "4:5",
    voice:
      "Visual-first: the image carries the idea and the caption adds one thought. A few relevant hashtags at the end, never more than five.",
    rules: [
      "The post must make sense from the image alone.",
      "Links do not work in captions — point to the profile link instead.",
    ],
  },
  local: {
    platform: "local",
    label: { "es-MX": "Comunidad local", en: "Local community", fr: "Communauté locale" },
    defaultPromoPolicy: "open",
    maxChars: 500,
    linkPlacement: "inline",
    imageAspect: "1.91:1",
    voice: "Concrete and local: name the place, the time and who it is for.",
    rules: ["Mention the specific place or neighbourhood so it reads as local, not generic."],
  },
  other: {
    platform: "other",
    label: { "es-MX": "Otro canal", en: "Other channel", fr: "Autre canal" },
    defaultPromoPolicy: "unknown",
    maxChars: 600,
    linkPlacement: "inline",
    imageAspect: "1.91:1",
    voice: "Clear and friendly, with no assumptions about the audience's context.",
    rules: ["Keep it self-contained — the reader may have no context about the teacher."],
  },
};

export function platformSpec(platform: MarketingPlatform): PlatformSpec {
  return PLATFORM_SPECS[platform];
}

export function platformLabel(platform: MarketingPlatform, locale: AppLocale): string {
  return PLATFORM_SPECS[platform].label[locale];
}

const PROMO_POLICY_LABELS: Record<PromoPolicy, Record<AppLocale, string>> = {
  open: {
    "es-MX": "Permite promoción",
    en: "Promotion allowed",
    fr: "Promotion autorisée",
  },
  limited: {
    "es-MX": "Promoción limitada",
    en: "Limited promotion",
    fr: "Promotion limitée",
  },
  prohibited: {
    "es-MX": "Sin promoción",
    en: "No promotion",
    fr: "Aucune promotion",
  },
  unknown: {
    "es-MX": "Reglas sin confirmar",
    en: "Rules unconfirmed",
    fr: "Règles non confirmées",
  },
};

export function promoPolicyLabel(policy: PromoPolicy, locale: AppLocale): string {
  return PROMO_POLICY_LABELS[policy][locale];
}

/**
 * Whether a directly promotional post (an offer, a price, a booking link) may
 * be planned for a community with this policy.
 *
 * `unknown` is treated as NOT allowed. A teacher who has not told us the
 * community's rules gets educational content there — which is welcome
 * everywhere — instead of a promotional post that might get her removed. The
 * conservative default is the whole point.
 */
export function allowsDirectPromotion(policy: PromoPolicy): boolean {
  return policy === "open" || policy === "limited";
}

/** Whether a tracked link may appear in the body of a post here. */
export function allowsInlineLink(platform: MarketingPlatform, policy: PromoPolicy): boolean {
  return PLATFORM_SPECS[platform].linkPlacement === "inline" && allowsDirectPromotion(policy);
}
