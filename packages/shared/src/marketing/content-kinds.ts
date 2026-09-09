// What kinds of thing a teacher can actually post, and what each one needs to
// be worth posting.
//
// The registry is the product opinion in data form. Two facts drive it:
//
//   1. Educational and genuinely useful content acquires students better than
//      repeated advertising of a booking page, and it is welcome in communities
//      where an advertisement is not. So the educational family is the default
//      and the promotional family is rationed.
//   2. A content kind has PREREQUISITES. "Testimonial post" with no published
//      testimonial produces a fabrication; "package offer" with no package
//      produces a dead link. Encoding the prerequisites here is what keeps the
//      planner from scheduling work that cannot honestly be done.

import type { AppLocale } from "../i18n/locales";
import { allowsDirectPromotion, type MarketingPlatform, type PromoPolicy } from "./channels";

export type MarketingContentFamily =
  "direct" | "educational" | "engagement" | "social_proof" | "referral";

export type MarketingContentKind =
  // direct
  | "intro"
  | "availability"
  | "package_offer"
  // educational
  | "tip"
  | "common_mistake"
  | "mini_lesson"
  | "phrase_of_the_day"
  // engagement
  | "discussion_question"
  | "this_or_that"
  // social proof
  | "testimonial"
  | "student_story"
  // referral
  | "referral_ask"
  // helpful reply to someone else's post
  | "community_reply";

export const MARKETING_CONTENT_KINDS: readonly MarketingContentKind[] = [
  "intro",
  "availability",
  "package_offer",
  "tip",
  "common_mistake",
  "mini_lesson",
  "phrase_of_the_day",
  "discussion_question",
  "this_or_that",
  "testimonial",
  "student_story",
  "referral_ask",
  "community_reply",
] as const;

export function isMarketingContentKind(value: unknown): value is MarketingContentKind {
  return (
    typeof value === "string" && (MARKETING_CONTENT_KINDS as readonly string[]).includes(value)
  );
}

/** What a teacher must already have for this kind to be honest. */
export type ContentPrerequisite = "testimonial" | "package" | "students" | "availability" | "photo";

export type ContentKindSpec = {
  kind: MarketingContentKind;
  family: MarketingContentFamily;
  label: Record<AppLocale, string>;
  /** One line the teacher reads to know what she is about to post. */
  summary: Record<AppLocale, string>;
  /** Platforms this kind belongs on at all. */
  platforms: readonly MarketingPlatform[];
  /** True when the kind is a direct offer and needs a permissive community. */
  promotional: boolean;
  /** True when an image materially helps the post land. */
  wantsImage: boolean;
  /** True when the post should carry a tracked booking link. */
  wantsLink: boolean;
  prerequisites: readonly ContentPrerequisite[];
  /** The generation brief, injected into the prompt. */
  brief: string;
};

const ALL_POST_PLATFORMS: readonly MarketingPlatform[] = [
  "facebook_group",
  "instagram",
  "local",
  "other",
];

export const CONTENT_KIND_SPECS: Record<MarketingContentKind, ContentKindSpec> = {
  intro: {
    kind: "intro",
    family: "direct",
    label: { "es-MX": "Preséntate", en: "Introduce yourself", fr: "Présentez-vous" },
    summary: {
      "es-MX": "Quién eres, a quién enseñas y cómo trabajas.",
      en: "Who you are, who you teach and how you work.",
      fr: "Qui vous êtes, qui vous enseignez et comment vous travaillez.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: true,
    wantsImage: true,
    wantsLink: true,
    prerequisites: ["photo"],
    brief:
      "A first-person introduction. Lead with who the teacher helps and the concrete problem she solves, not with credentials. One specific detail that could only be true of her.",
  },
  availability: {
    kind: "availability",
    family: "direct",
    label: { "es-MX": "Anuncia tu cupo", en: "Announce open spots", fr: "Annoncez vos créneaux" },
    summary: {
      "es-MX": "Los horarios que tienes libres esta semana.",
      en: "The slots you actually have free this week.",
      fr: "Les créneaux réellement libres cette semaine.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: true,
    wantsImage: false,
    wantsLink: true,
    prerequisites: ["availability"],
    brief:
      "State the real days and times that are open, in the reader's terms. Scarcity only if it is true — never invent 'last two spots'.",
  },
  package_offer: {
    kind: "package_offer",
    family: "direct",
    label: { "es-MX": "Presenta un paquete", en: "Present a package", fr: "Présentez un forfait" },
    summary: {
      "es-MX": "Qué incluye un paquete y para quién es.",
      en: "What a package includes and who it suits.",
      fr: "Ce qu'un forfait comprend et à qui il convient.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: true,
    wantsImage: true,
    wantsLink: true,
    prerequisites: ["package"],
    brief:
      "Describe one package by what the student will be able to DO by the end of it. Price stated plainly once, never repeated or dramatised.",
  },
  tip: {
    kind: "tip",
    family: "educational",
    label: { "es-MX": "Un consejo útil", en: "A useful tip", fr: "Un conseil utile" },
    summary: {
      "es-MX": "Algo que un aprendiz puede usar hoy mismo.",
      en: "Something a learner can use today.",
      fr: "Quelque chose qu'un apprenant peut utiliser aujourd'hui.",
    },
    platforms: [...ALL_POST_PLATFORMS, "reddit"],
    promotional: false,
    wantsImage: true,
    wantsLink: false,
    prerequisites: [],
    brief:
      "One narrow, immediately usable tip with a concrete example in the target language plus its translation. Complete on its own — no cliffhanger, no 'DM me to learn more'.",
  },
  common_mistake: {
    kind: "common_mistake",
    family: "educational",
    label: { "es-MX": "Un error común", en: "A common mistake", fr: "Une erreur fréquente" },
    summary: {
      "es-MX": "El error que casi todos cometen, y el arreglo.",
      en: "The mistake almost everyone makes, and the fix.",
      fr: "L'erreur que presque tout le monde fait, et la correction.",
    },
    platforms: [...ALL_POST_PLATFORMS, "reddit"],
    promotional: false,
    wantsImage: true,
    wantsLink: false,
    prerequisites: [],
    brief:
      "Name one mistake the teacher's actual students make, show the wrong version and the right version side by side, and explain the why in one sentence.",
  },
  mini_lesson: {
    kind: "mini_lesson",
    family: "educational",
    label: { "es-MX": "Mini lección", en: "Mini lesson", fr: "Mini-leçon" },
    summary: {
      "es-MX": "Una idea explicada de principio a fin.",
      en: "One idea explained start to finish.",
      fr: "Une idée expliquée du début à la fin.",
    },
    platforms: [...ALL_POST_PLATFORMS, "reddit"],
    promotional: false,
    wantsImage: false,
    wantsLink: false,
    prerequisites: [],
    brief:
      "Teach one small thing properly: the rule, two or three examples, and the single case where learners get it wrong. It must stand alone as a complete lesson.",
  },
  phrase_of_the_day: {
    kind: "phrase_of_the_day",
    family: "educational",
    label: { "es-MX": "Frase del día", en: "Phrase of the day", fr: "Expression du jour" },
    summary: {
      "es-MX": "Una expresión real que se usa de verdad.",
      en: "A real expression people actually use.",
      fr: "Une expression que les gens utilisent vraiment.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: false,
    wantsImage: true,
    wantsLink: false,
    prerequisites: [],
    brief:
      "One idiomatic phrase, its literal translation, its real meaning, and one line of when you would say it. Prefer expressions a textbook would miss.",
  },
  discussion_question: {
    kind: "discussion_question",
    family: "engagement",
    label: {
      "es-MX": "Pregunta a la comunidad",
      en: "Ask the community",
      fr: "Question à la communauté",
    },
    summary: {
      "es-MX": "Una pregunta que la gente quiere contestar.",
      en: "A question people actually want to answer.",
      fr: "Une question à laquelle les gens ont envie de répondre.",
    },
    platforms: [...ALL_POST_PLATFORMS, "reddit"],
    promotional: false,
    wantsImage: false,
    wantsLink: false,
    prerequisites: [],
    brief:
      "One open question about learning the language that a member can answer from their own experience in a sentence. No preamble about the teacher.",
  },
  this_or_that: {
    kind: "this_or_that",
    family: "engagement",
    label: { "es-MX": "¿Cuál dirías?", en: "Which would you say?", fr: "Lequel diriez-vous ?" },
    summary: {
      "es-MX": "Dos opciones, una correcta. Invita a responder.",
      en: "Two options, one right. It invites a reply.",
      fr: "Deux options, une correcte. Cela invite à répondre.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: false,
    wantsImage: true,
    wantsLink: false,
    prerequisites: [],
    brief:
      "Present two plausible options in the target language and ask which is right. Give the answer and the reason at the end, separated clearly, so the post is still useful to a silent reader.",
  },
  testimonial: {
    kind: "testimonial",
    family: "social_proof",
    label: {
      "es-MX": "Comparte una reseña",
      en: "Share a testimonial",
      fr: "Partagez un témoignage",
    },
    summary: {
      "es-MX": "Las palabras de un alumno, con contexto.",
      en: "A student's own words, with context.",
      fr: "Les mots d'un élève, avec du contexte.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: true,
    wantsImage: true,
    wantsLink: true,
    prerequisites: ["testimonial"],
    brief:
      "Quote a published testimonial VERBATIM. Do not embellish, rewrite or invent any part of it. Add one sentence of context about what that student was working on.",
  },
  student_story: {
    kind: "student_story",
    family: "social_proof",
    label: {
      "es-MX": "Una historia de progreso",
      en: "A progress story",
      fr: "Une histoire de progrès",
    },
    summary: {
      "es-MX": "De dónde salió un alumno y a dónde llegó.",
      en: "Where a student started and where they got to.",
      fr: "D'où un élève est parti et où il est arrivé.",
    },
    platforms: ALL_POST_PLATFORMS,
    promotional: true,
    wantsImage: false,
    wantsLink: true,
    prerequisites: ["students", "testimonial"],
    brief:
      "A short before-and-after narrative grounded ONLY in the supplied testimonial and package facts. Never name a student who has not been quoted. Never invent a milestone.",
  },
  referral_ask: {
    kind: "referral_ask",
    family: "referral",
    label: {
      "es-MX": "Pide una recomendación",
      en: "Ask for a referral",
      fr: "Demandez une recommandation",
    },
    summary: {
      "es-MX": "Un mensaje corto para tus alumnos actuales.",
      en: "A short message to your current students.",
      fr: "Un court message à vos élèves actuels.",
    },
    platforms: ["whatsapp", "other"],
    promotional: false,
    wantsImage: false,
    wantsLink: true,
    prerequisites: ["students"],
    brief:
      "A message to one existing student, thanking them for something specific and asking whether they know one person who might want the same. Never guilt, never bulk-sounding, never more than four lines.",
  },
  community_reply: {
    kind: "community_reply",
    family: "educational",
    label: { "es-MX": "Responde a alguien", en: "Reply to someone", fr: "Répondez à quelqu'un" },
    summary: {
      "es-MX": "Ayuda a alguien que ya preguntó algo.",
      en: "Help someone who already asked a question.",
      fr: "Aidez quelqu'un qui a déjà posé une question.",
    },
    platforms: ["reddit", "facebook_group", "other"],
    promotional: false,
    wantsImage: false,
    wantsLink: false,
    prerequisites: [],
    brief:
      "Answer the quoted question directly and completely in the first sentence, then add the one nuance most answers miss. Mention teaching at most once, at the end, and only if it is relevant. No link, no offer.",
  },
};

export function contentKindSpec(kind: MarketingContentKind): ContentKindSpec {
  return CONTENT_KIND_SPECS[kind];
}

export function contentKindLabel(kind: MarketingContentKind, locale: AppLocale): string {
  return CONTENT_KIND_SPECS[kind].label[locale];
}

export function contentKindSummary(kind: MarketingContentKind, locale: AppLocale): string {
  return CONTENT_KIND_SPECS[kind].summary[locale];
}

/** What a teacher already has, as far as content honesty is concerned. */
export type ContentCapabilities = {
  hasTestimonial: boolean;
  hasPackage: boolean;
  hasStudents: boolean;
  hasAvailability: boolean;
  hasPhoto: boolean;
};

export function meetsPrerequisites(spec: ContentKindSpec, caps: ContentCapabilities): boolean {
  return spec.prerequisites.every((p) => {
    switch (p) {
      case "testimonial":
        return caps.hasTestimonial;
      case "package":
        return caps.hasPackage;
      case "students":
        return caps.hasStudents;
      case "availability":
        return caps.hasAvailability;
      case "photo":
        return caps.hasPhoto;
    }
  });
}

/**
 * Every content kind that could honestly and safely be posted to a community
 * with this platform and promo policy, given what the teacher has.
 *
 * The promo-policy filter is the platform-safety gate: a promotional kind is
 * simply not offered where promotion is prohibited or unconfirmed.
 */
export function eligibleContentKinds(input: {
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  capabilities: ContentCapabilities;
}): MarketingContentKind[] {
  const promoOk = allowsDirectPromotion(input.promoPolicy);
  return MARKETING_CONTENT_KINDS.filter((kind) => {
    const spec = CONTENT_KIND_SPECS[kind];
    if (!spec.platforms.includes(input.platform)) return false;
    if (spec.promotional && !promoOk) return false;
    return meetsPrerequisites(spec, input.capabilities);
  });
}
