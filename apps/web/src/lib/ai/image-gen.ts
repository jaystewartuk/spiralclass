import "server-only";
import { hasGeminiImageCreds } from "@/lib/env";

// Vendor-neutral image-generation seam for social previews (D-123).
//
// Deliberately the SAME shape as lib/ai/tts.ts, which already proves the
// pattern in production: one exported function, a result union both rails
// return, and the concrete provider chosen here by which credentials are set.
// Adapters are imported dynamically (they pull `server-only`) so this module's
// static graph — and the route-inventory test that loads every handler — stays
// clean.
//
// A note on why this seam is cheap rather than speculative: because the caller
// only ever asks for a TEXT-FREE background (SpiralClass renders all copy over
// it with Satori), the thing providers differ on most — in-image text fidelity
// — is designed out. What is left is a commodity: bytes of a landscape image.
// Swapping Gemini for GPT Image, Imagen or Flux is one adapter file plus one
// line below, with nothing downstream to re-tune.

export type GeneratedImage = {
  bytes: Uint8Array;
  contentType: string;
  provider: string;
  model: string;
};

export type GenerateImageResult =
  | { ok: true; image: GeneratedImage }
  // `blocked` is distinct from `error` on purpose: it is the provider's safety
  // filter refusing the brief, which is a message to the TEACHER ("try
  // describing it differently"), not an incident to retry or page on.
  | { ok: false; reason: "not-configured" | "blocked" | "empty" | "timeout" | "error" };

export type GenerateImageOptions = {
  /** Provider-side aspect ratio hint. The composer covers/crops to the exact
   * canonical size regardless, so this only has to be close. */
  aspectRatio?: string;
  timeoutMs?: number;
};

/** How long we will wait on a provider before giving up.
 *
 * Generation is a foreground action a teacher is watching, and the whole
 * feature's promise is "less effort than ChatGPT" — a request still spinning
 * after this long has already lost that argument, and the failure is
 * recoverable (nothing is written, no quota is consumed, she can retry). */
export const IMAGE_GENERATION_TIMEOUT_MS = 60_000;

export async function generateImage(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  if (hasGeminiImageCreds()) {
    const { generateWithGemini } = await import("./gemini-image");
    return generateWithGemini(prompt, opts);
  }
  return { ok: false, reason: "not-configured" };
}
