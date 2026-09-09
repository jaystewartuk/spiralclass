// The teacher's image-generation preferences, as a vocabulary both clients
// share.
//
// The problem this fixes is concrete. Image generation used to take exactly two
// inputs — one of four angles and a 160-character topic — and everything else
// was a fixed string in a server module. Every teacher on the platform
// therefore got the same brief, and the meme angle asked, verbatim, for "one
// clear human subject with an exaggerated, instantly readable facial
// expression". That single sentence is why every generated meme was a
// surprised-looking person: it was not the model defaulting, it was us asking.
//
// So the brief now has three authors, and the UI names them in exactly these
// terms:
//
//   1. SpiralClass — the rules that never change (no text in the image, a
//      composition that survives a thumbnail, nothing unsafe). Not editable,
//      but explained, because a teacher who cannot see why her request was
//      altered concludes the tool ignored her.
//   2. The teacher — her general instructions, once, reused everywhere. Her
//      niche, her humour, her audience, what she never wants to see.
//   3. The community — what is different about THIS audience.
//
// Only the vocabulary and the bounds live here. The prompt itself stays
// server-side (apps/web/src/lib/social-preview/prompt.ts) and is never
// client-supplied.

import type { AppLocale } from "../i18n/locales";

/**
 * The visual style a teacher prefers. A short curated list, not free text:
 * style is the one dimension where a picker beats a sentence, because the
 * teacher knows what she likes when she sees it named and rarely knows how to
 * ask an image model for it.
 *
 * `varied` is the default and it is not a cop-out — it is the anti-repetition
 * mechanism. A teacher who never touches this gets a different visual register
 * on every generation instead of the same one forever.
 */
export const MEME_STYLES = [
  "varied",
  "photo",
  "illustration",
  "bold_graphic",
  "retro",
  "hand_drawn",
] as const;

export type MemeStyle = (typeof MEME_STYLES)[number];

export function isMemeStyle(value: unknown): value is MemeStyle {
  return typeof value === "string" && (MEME_STYLES as readonly string[]).includes(value);
}

export const DEFAULT_MEME_STYLE: MemeStyle = "varied";

export type MemeStyleSpec = {
  style: MemeStyle;
  label: Record<AppLocale, string>;
  /** One line the teacher reads. Plain language, no model vocabulary. */
  summary: Record<AppLocale, string>;
};

export const MEME_STYLE_SPECS: Record<MemeStyle, MemeStyleSpec> = {
  varied: {
    style: "varied",
    label: { "es-MX": "Variado", en: "Varied", fr: "Varié" },
    summary: {
      "es-MX": "Cambiamos el estilo en cada imagen para que no se repitan.",
      en: "We change the look each time so your images never repeat.",
      fr: "Nous changeons de style à chaque fois pour éviter les répétitions.",
    },
  },
  photo: {
    style: "photo",
    label: { "es-MX": "Fotografía", en: "Photography", fr: "Photographie" },
    summary: {
      "es-MX": "Fotos reales de la vida diaria.",
      en: "Real, everyday photography.",
      fr: "De vraies photos du quotidien.",
    },
  },
  illustration: {
    style: "illustration",
    label: { "es-MX": "Ilustración", en: "Illustration", fr: "Illustration" },
    summary: {
      "es-MX": "Ilustración digital limpia y colorida.",
      en: "Clean, colourful digital illustration.",
      fr: "Illustration numérique nette et colorée.",
    },
  },
  bold_graphic: {
    style: "bold_graphic",
    label: { "es-MX": "Gráfico llamativo", en: "Bold graphic", fr: "Graphique audacieux" },
    summary: {
      "es-MX": "Formas simples y colores fuertes que se ven bien en miniatura.",
      en: "Simple shapes and strong colour that read well at thumbnail size.",
      fr: "Formes simples et couleurs franches, lisibles en miniature.",
    },
  },
  retro: {
    style: "retro",
    label: { "es-MX": "Retro", en: "Retro", fr: "Rétro" },
    summary: {
      "es-MX": "Aire vintage: impresión antigua, película, carteles viejos.",
      en: "Vintage feel: old print, film grain, mid-century poster.",
      fr: "Ambiance vintage : vieille impression, grain argentique, affiche rétro.",
    },
  },
  hand_drawn: {
    style: "hand_drawn",
    label: { "es-MX": "Dibujado a mano", en: "Hand drawn", fr: "Dessiné à la main" },
    summary: {
      "es-MX": "Trazo suelto, como un cuaderno de apuntes.",
      en: "Loose sketch, like a notebook doodle.",
      fr: "Trait libre, comme un carnet de croquis.",
    },
  },
};

export function memeStyleSpec(style: MemeStyle): MemeStyleSpec {
  return MEME_STYLE_SPECS[style];
}

export function memeStyleLabel(style: MemeStyle, locale: AppLocale): string {
  return MEME_STYLE_SPECS[style].label[locale];
}

/**
 * The teacher's reusable instructions.
 *
 * Long enough for a real paragraph about her niche, her humour and her
 * red lines; short enough that it stays a preference rather than becoming a
 * prompt she has to maintain. It is bounded here because it is teacher text
 * that reaches an image provider, and both clients must refuse the same input.
 */
export const TEACHER_MEME_BRIEF_MAX_CHARS = 700;

/** The same, for one community. Same size: the two are peers, not a field and
 * a footnote — a teacher may well have more to say about one hard audience
 * than about her general taste. */
export const COMMUNITY_MEME_BRIEF_MAX_CHARS = 700;

/** The fixed rules, in the teacher's language, for the "what we always do"
 * disclosure. This is the transparency contract: she never reads the system
 * prompt, but she is never left guessing why her image came back different
 * from what she typed either. */
export const MEME_FIXED_RULES: Record<AppLocale, readonly string[]> = {
  "es-MX": [
    "Nunca pedimos texto dentro de la imagen — tu frase la escribimos nosotros encima, siempre bien escrita y con acentos.",
    "Pedimos una composición que se entienda en miniatura, porque así se ve al compartirla.",
    "No pedimos nada ofensivo, ni marcas, ni personas reales identificables.",
  ],
  en: [
    "We never ask for text inside the image — your caption is drawn over it by us, always spelled correctly and accented.",
    "We ask for a composition that still reads at thumbnail size, because that is how it gets shared.",
    "We never ask for anything offensive, branded, or featuring a real identifiable person.",
  ],
  fr: [
    "Nous ne demandons jamais de texte dans l'image — votre légende est ajoutée par nous, toujours correctement orthographiée et accentuée.",
    "Nous demandons une composition lisible en miniature, car c'est ainsi qu'elle est partagée.",
    "Nous ne demandons jamais rien d'offensant, de marqué, ni de personne réelle identifiable.",
  ],
};
