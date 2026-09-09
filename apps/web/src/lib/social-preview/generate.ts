import "server-only";
import { randomUUID } from "node:crypto";
import {
  normalizeSocialPreviewTopic,
  SOCIAL_PREVIEW_HEIGHT,
  SOCIAL_PREVIEW_WIDTH,
  type MemeStyle,
  type SocialPreviewAngle,
  type SocialPreviewImageView,
} from "@spiralclass/shared";
import { generateImage } from "@/lib/ai/image-gen";
import { socialPreviewAiEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { languageDisplayName } from "@/lib/language-name";
import { getCommunity } from "@/lib/marketing/communities";
import { getMemeSettings } from "@/lib/marketing/profile";
import { rateLimit } from "@/lib/rate-limit";
import {
  putSocialPreviewImage,
  socialPreviewImagePublicUrl,
} from "@/lib/storage/social-preview-image";
import { buildSocialPreviewPrompt } from "./prompt";
import { createSocialPreviewImage, socialPreviewQuota } from "./store";

const log = logger({ surface: "social-preview" });

// One AI generation, end to end (D-123). Owned here so every caller enforces
// the same gate, the same cap and the same failure vocabulary.
//
// Ordering is deliberate — every cheap refusal happens before a paid call:
//   feature gate -> rate limit -> monthly cap -> provider -> storage -> row.
// And the row is written LAST, so a storage failure can never leave a ledger
// entry pointing at bytes that aren't there, and a provider failure never
// consumes a teacher's allowance.

/**
 * Short-window throttle on top of the monthly cap.
 *
 * The cap bounds the month; this bounds a bad minute — a stuck retry loop or a
 * double-click storm can otherwise burn a whole month's allowance (and its
 * cost) before anyone notices. Five is comfortably above deliberate
 * "generate another" use and far below anything automated.
 */
const GENERATE_RATE_LIMIT = { scope: "social-preview-generate", limit: 6, windowMs: 10 * 60_000 };

export type GenerateSocialPreviewInput = {
  teacherId: string;
  /** From entitlementsFor() — decides which monthly cap applies. */
  isPro: boolean;
  /** teacher.teachingLanguage, so she never has to restate what she teaches. */
  teachingLanguage: string;
  angle: SocialPreviewAngle;
  topic?: string | null;
  /**
   * Which community this image is for, when it is for one.
   *
   * Ownership is re-checked here rather than trusted from the caller: a
   * community id arriving from a form is an untrusted value, and the only
   * consequence of a wrong one must be "no community context", never another
   * teacher's audience note reaching this teacher's prompt.
   */
  communityId?: string | null;
  /** Test seam: the two brief fields and the style, resolved by the caller.
   * Production callers omit these and let this module read them. */
  overrides?: {
    teacherBrief?: string | null;
    memeStyle?: MemeStyle;
    communityBrief?: string | null;
    audienceNote?: string | null;
  };
};

export type GenerateSocialPreviewResult =
  | { ok: true; image: SocialPreviewImageView; quota: { used: number; cap: number } }
  | {
      ok: false;
      // Each of these maps to a distinct, actionable message. "cap"/"throttled"
      // are the teacher's own usage; "blocked" is the provider refusing the
      // brief; the rest are ours and are all retryable.
      reason:
        | "not-configured"
        | "throttled"
        | "cap"
        | "blocked"
        | "timeout"
        | "empty"
        | "storage"
        | "error";
      retryAfterMs?: number;
      quota?: { used: number; cap: number };
    };

export async function generateSocialPreviewImage(
  input: GenerateSocialPreviewInput,
): Promise<GenerateSocialPreviewResult> {
  if (!socialPreviewAiEnabled()) return { ok: false, reason: "not-configured" };

  const throttle = await rateLimit(input.teacherId, GENERATE_RATE_LIMIT);
  if (!throttle.ok) {
    return { ok: false, reason: "throttled", retryAfterMs: throttle.retryAfterMs };
  }

  const quota = await socialPreviewQuota(input.teacherId, input.isPro);
  if (quota.remaining <= 0) {
    return { ok: false, reason: "cap", quota: { used: quota.used, cap: quota.cap } };
  }

  const topic = normalizeSocialPreviewTopic(input.topic);

  // The three authors of the brief: SpiralClass (in prompt.ts), the teacher
  // (her general instructions), and the community (this audience's specifics).
  const [settings, community] = await Promise.all([
    input.overrides?.teacherBrief !== undefined || input.overrides?.memeStyle !== undefined
      ? Promise.resolve({
          memeBrief: input.overrides.teacherBrief ?? null,
          memeStyle: input.overrides.memeStyle ?? "varied",
        })
      : getMemeSettings(input.teacherId),
    input.communityId ? getCommunity(input.teacherId, input.communityId) : Promise.resolve(null),
  ]);

  const prompt = buildSocialPreviewPrompt({
    angle: input.angle,
    topic,
    // "en" rather than the teacher's UI locale: this string goes into a prompt,
    // not onto a screen, and image models are most reliable with English
    // language names.
    language: languageDisplayName(input.teachingLanguage, "en") ?? "Spanish",
    style: settings.memeStyle,
    teacherBrief: settings.memeBrief,
    communityBrief: input.overrides?.communityBrief ?? community?.memeBrief ?? null,
    audienceNote: input.overrides?.audienceNote ?? community?.audienceNote ?? null,
    // The rotation seed. `quota.used` is the count of AI images she has made
    // this month, so it increments on every success — which makes "generate
    // another" reliably produce a DIFFERENT framing rather than rolling dice
    // that can land on the same one twice.
    variation: quota.used,
  });

  const generated = await generateImage(prompt);
  if (!generated.ok) {
    log.warn("generation failed", { teacherId: input.teacherId, reason: generated.reason });
    // "not-configured" from the adapter means the flag is on but the credential
    // vanished — same message to the teacher either way.
    return { ok: false, reason: generated.reason };
  }

  const imageId = randomUUID();
  const extension = generated.image.contentType.includes("jpeg") ? "jpg" : "png";
  const { path, error } = await putSocialPreviewImage({
    teacherId: input.teacherId,
    imageId,
    extension,
    contentType: generated.image.contentType,
    body: generated.image.bytes,
  });
  if (error) {
    log.error("generated image upload failed", { teacherId: input.teacherId, error });
    // No row is written, so the allowance is untouched and a retry is clean.
    return { ok: false, reason: "storage" };
  }

  const row = await createSocialPreviewImage({
    id: imageId,
    teacherId: input.teacherId,
    source: "ai",
    angle: input.angle,
    topic,
    prompt,
    provider: generated.image.provider,
    model: generated.image.model,
    storagePath: path,
    // The asset is stored at whatever the provider returned; these record the
    // canvas it was generated FOR, which is what the composer renders into.
    width: SOCIAL_PREVIEW_WIDTH,
    height: SOCIAL_PREVIEW_HEIGHT,
  });

  return {
    ok: true,
    image: {
      id: row.id,
      source: row.source,
      angle: row.angle,
      topic: row.topic,
      url: socialPreviewImagePublicUrl(row.storagePath),
      createdAt: row.createdAt.toISOString(),
    },
    quota: { used: quota.used + 1, cap: quota.cap },
  };
}
