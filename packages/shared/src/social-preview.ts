// Social previews (D-123) — the per-share-link OG/social image a teacher
// uploads or generates for her booking link.
//
// This module owns the parts BOTH clients must agree on: the configuration
// vocabulary (angle), the field bounds, the canonical card dimensions, and the
// wire shapes. The provider prompt, the storage lifecycle and the Satori
// composition all stay server-side (apps/web/src/lib/social-preview,
// apps/web/src/lib/ai/image-gen) — a client never needs to know any of that,
// and the prompt in particular must never be client-supplied.

/** How the underlying image asset came to exist. */
export type SocialPreviewSource = "upload" | "ai" | "template" | "system";

/**
 * The one configuration dimension a teacher picks when generating.
 *
 * ONE axis, not the purpose-times-style matrix the design brief floated: for
 * language teachers those two are ~95% correlated ("make them laugh" is a funny
 * meme; "promote my classes" is a clean card), so a 24-cell matrix would mostly
 * offer combinations whose output nobody — teacher or product — can predict,
 * while multiplying the analytics cardinality before there is a single row of
 * data to break down.
 *
 * The name is `angle` rather than `type` or `style` on purpose: a second
 * dimension (a real `style`, a `platform`) is then an ADDITIVE field later
 * instead of a rename that would orphan every stored row and every recorded
 * analytics event.
 */
export const SOCIAL_PREVIEW_ANGLES = ["meme", "promo", "tip", "motivation"] as const;
export type SocialPreviewAngle = (typeof SOCIAL_PREVIEW_ANGLES)[number];

export function isSocialPreviewAngle(value: unknown): value is SocialPreviewAngle {
  return typeof value === "string" && (SOCIAL_PREVIEW_ANGLES as readonly string[]).includes(value);
}

// --- Canonical dimensions ----------------------------------------------------

/**
 * The one canonical social card: 1200x630 (1.91:1).
 *
 * Facebook's and LinkedIn's recommended size, the generic Open Graph standard,
 * and it crops cleanly into X's `summary_large_image`. We deliberately generate
 * ONE asset rather than per-platform crops: platform-specific images only earn
 * their keep once there are platform-specific LINKS to hang them off, which
 * there aren't yet (see D-123 "future extensibility").
 */
export const SOCIAL_PREVIEW_WIDTH = 1200;
export const SOCIAL_PREVIEW_HEIGHT = 630;

/**
 * The fraction of the card's width, centred, that must stay legible.
 *
 * WhatsApp renders a near-square crop of the card as its in-chat thumbnail, so
 * anything anchored to the left or right edge is simply gone there. The caption
 * is therefore laid out inside this central band and the brand footer — which
 * is expendable — takes the bottom edge.
 */
export const SOCIAL_PREVIEW_SAFE_WIDTH_RATIO = SOCIAL_PREVIEW_HEIGHT / SOCIAL_PREVIEW_WIDTH;

// --- Field bounds ------------------------------------------------------------

/**
 * The teacher's own description of what the image should be about, in her
 * words — "students learning Mexican Spanish", not a prompt.
 *
 * Short on purpose. It is the ONE free-text value that reaches an image
 * provider, so it is bounded before it is embedded in a prompt we control;
 * and a sentence is genuinely all this input needs, because everything else
 * (her teaching language, her name, the angle) is already known.
 */
export const SOCIAL_PREVIEW_TOPIC_MAX_CHARS = 160;

/**
 * The caption SpiralClass renders over the image.
 *
 * Two lines of large type at 1200x630 is roughly this many characters; past it
 * the text either shrinks below thumbnail legibility or overflows the safe
 * band. Bounded here so web and mobile refuse the same input.
 */
export const SOCIAL_PREVIEW_CAPTION_MAX_CHARS = 120;

/** Upload ceiling — matches the teacher-photo/testimonial-avatar ceiling. */
export const SOCIAL_PREVIEW_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** content-type -> extension for uploads. Validation is by DECLARED TYPE and
 * the extension is DERIVED from it, so an `evil.svg` announced as `image/png`
 * is stored as `.png` and can only ever decode as one — the same rule
 * lib/storage/material-images.ts follows. */
export const SOCIAL_PREVIEW_UPLOAD_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function socialPreviewUploadExtension(contentType: string): string | null {
  return SOCIAL_PREVIEW_UPLOAD_TYPES[contentType.toLowerCase().trim()] ?? null;
}

// --- Generation allowance ----------------------------------------------------

/**
 * Monthly AI generations, by plan.
 *
 * A monthly allowance on Free rather than the flat Pro gate used for the
 * homework/intro-video AI helpers, and for a specific reason: this is
 * the feature that turns a Free teacher into a paying one, so putting it fully
 * behind the paywall would gate acquisition on already having converted.
 *
 * 20/month is roughly four or five real social posts with three or four
 * regenerations each — the usage this was built for — and costs on the order of
 * a dollar a month against a GBP 7.99 subscription. A teacher who exhausts it
 * can still upload her own image, which is never capped.
 */
export const SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE = 3;
export const SOCIAL_PREVIEW_AI_PRO_MONTHLY_CAP = 20;

export function socialPreviewMonthlyCap(isPro: boolean): number {
  return isPro ? SOCIAL_PREVIEW_AI_PRO_MONTHLY_CAP : SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE;
}

// --- Wire shapes -------------------------------------------------------------

/** One stored asset, as both clients see it. */
export type SocialPreviewImageView = {
  id: string;
  source: SocialPreviewSource;
  angle: SocialPreviewAngle | null;
  topic: string | null;
  /** Public URL of the raw BACKGROUND (not the composed card). */
  url: string | null;
  createdAt: string;
};

/** One placement, as both clients see it. */
export type SocialPreviewView = {
  id: string;
  /** null = the teacher's default preview for untagged shares. */
  shareGroupId: string | null;
  caption: string;
  image: SocialPreviewImageView;
  /** Absolute URL of the COMPOSED card, cache-busted — what og:image points at. */
  cardUrl: string;
};

/** Everything the mobile editor needs in one round trip: what is configured,
 * what images exist to choose from, and how much allowance is left. Bundled
 * because rendering the screen needs all three and three separate requests
 * would each pay the same auth + cold-start cost. */
export type SocialPreviewBundle = {
  previews: SocialPreviewView[];
  images: SocialPreviewImageView[];
  quota: { used: number; cap: number; remaining: number };
};

/** What the teacher fills in to generate. The provider prompt is built from
 * this server-side; a client never sends prompt text. */
export type SocialPreviewBrief = {
  angle: SocialPreviewAngle;
  topic?: string | null;
};

// C0 + C1 control characters. Written as escapes rather than literals so they
// stay visible in a diff and can't be normalised away by an editor.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function normalizeSocialPreviewTopic(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip control characters (newlines included) before the value is embedded
  // in a prompt we wrote: a multi-line topic is the cheapest way to try to
  // append instructions of one's own to the brief.
  const cleaned = raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SOCIAL_PREVIEW_TOPIC_MAX_CHARS);
  return cleaned || null;
}

export function normalizeSocialPreviewCaption(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SOCIAL_PREVIEW_CAPTION_MAX_CHARS);
}
