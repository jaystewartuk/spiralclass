import "server-only";
import { geminiImageModel, geminiVertexLocation, geminiVertexProjectId } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getVertexAccessToken } from "./google-vertex-auth";
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  type GenerateImageOptions,
  type GenerateImageResult,
} from "./image-gen";

const log = logger({ surface: "ai" });

// Gemini image generation — the default social-preview rail (D-123), called
// through VERTEX AI rather than the public Generative Language API (D-127).
//
// `generateContent`'s request/response shape is IDENTICAL between the two
// surfaces for this model (confirmed against a live call) — only the
// endpoint URL and the auth header differ. Auth is a Bearer token from
// google-vertex-auth.ts (a service account, since this runs on Fly, not
// GCP) rather than X-Goog-Api-Key, because Vertex has no API-key surface at
// all — every call is OAuth2.
//
// The response carries the image as base64 `inlineData` on a content part,
// alongside any text parts the model felt like adding; we take the first
// image part and ignore the rest.

// Global (not regional) — the only location gemini-3.1-flash-image is
// actually published to as of D-127; see geminiVertexLocation()'s comment.
function endpointFor(projectId: string, location: string, model: string): string {
  const host =
    location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

// Closest supported ratio to the canonical 1200x630 (1.905:1). The composer
// covers to the exact box, so the ~7% difference is absorbed by a crop rather
// than a letterbox.
const DEFAULT_ASPECT_RATIO = "16:9";

type InlineDataPart = { inlineData?: { mimeType?: string; data?: string } };
type GeminiResponse = {
  candidates?: { content?: { parts?: InlineDataPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export async function generateWithGemini(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  const projectId = geminiVertexProjectId();
  if (!projectId) return { ok: false, reason: "not-configured" };

  const accessToken = await getVertexAccessToken();
  if (!accessToken) return { ok: false, reason: "not-configured" };

  const model = geminiImageModel();
  const location = geminiVertexLocation();
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: opts.aspectRatio ?? DEFAULT_ASPECT_RATIO },
    },
  };

  let res: Response;
  try {
    res = await fetch(endpointFor(projectId, location, model), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException; anything
    // else here is a transport failure. Both are retryable by the teacher, but
    // only the first is worth telling her to simply wait out.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.warn("gemini image request failed", { model, timedOut });
    return { ok: false, reason: timedOut ? "timeout" : "error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 400 with a safety/policy body is the provider refusing the brief rather
    // than the request being malformed — surface it to the teacher as such.
    const blocked = res.status === 400 && /safety|policy|blocked|prohibited/i.test(text);
    log.warn("gemini image http error", {
      model,
      status: res.status,
      body: text.slice(0, 300),
    });
    return { ok: false, reason: blocked ? "blocked" : "error" };
  }

  let payload: GeminiResponse;
  try {
    payload = (await res.json()) as GeminiResponse;
  } catch {
    log.warn("gemini image: unparseable response", { model });
    return { ok: false, reason: "error" };
  }

  if (payload.promptFeedback?.blockReason) {
    log.info("gemini image blocked", { model, reason: payload.promptFeedback.blockReason });
    return { ok: false, reason: "blocked" };
  }

  const candidate = payload.candidates?.[0];
  // A candidate that stopped for safety carries no image part but also no
  // promptFeedback — check both or a refusal reads as an empty response.
  if (candidate?.finishReason && /safety|prohibited|blocklist/i.test(candidate.finishReason)) {
    log.info("gemini image blocked", { model, reason: candidate.finishReason });
    return { ok: false, reason: "blocked" };
  }

  const imagePart = candidate?.content?.parts?.find((p) => p.inlineData?.data);
  const data = imagePart?.inlineData?.data;
  if (!data) {
    log.warn("gemini image: no image part in response", { model });
    return { ok: false, reason: "empty" };
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };

  return {
    ok: true,
    image: {
      bytes: new Uint8Array(bytes),
      contentType: imagePart?.inlineData?.mimeType ?? "image/png",
      provider: "gemini",
      model,
    },
  };
}
