import Anthropic from "@anthropic-ai/sdk";
import { languageName } from "@spiralclass/shared";
import type { AgentConfig } from "./config";
import type { CaptionDirection } from "./app-client";
import { logEvent } from "./log";

// Direct Agent -> Anthropic translation, replacing a round-trip through the
// app's /api/internal/captions/translate route (removed alongside this).
// That route added a whole extra network hop (box -> Fly -> Anthropic) for
// zero business logic of its own — unlike room-config, translation has no
// DB/consent/entitlement dependency, so there was nothing worth centralizing
// in the app. Timing logs from the first live end-to-end test showed the
// translate call was ~100% of total caption latency (avg ~890ms), so cutting
// this hop is the single biggest lever available. Mirrors
// apps/web/src/lib/captions/translate.ts's prompt/model/fallback-latch logic
// closely on purpose (same product behavior), duplicated rather than shared
// since this package is a standalone deployable that doesn't depend on
// apps/web.

let client: Anthropic | null = null;

function anthropic(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export function buildCaptionTranslationPrompt(direction: CaptionDirection): string {
  const from = languageName(direction.source);
  const to = languageName(direction.target);
  return [
    `You are a live subtitle translator for a one-to-one language conversation.`,
    `Translate the ${from} text the speaker just said into natural, concise ${to}.`,
    `Rules:`,
    `- Output ONLY the ${to} translation — no quotes, no notes, no preamble.`,
    `- Keep it short and readable as an on-screen subtitle.`,
    `- If the text is already ${to}, or is just filler/noise, return it unchanged or empty.`,
    `- Never add commentary or explain your choices.`,
  ].join("\n");
}

export function extractTranslation(content: Anthropic.Message["content"]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// See apps/web/src/lib/captions/translate.ts's requestTranslation for why
// output_config.effort is never set here — it 400s on Haiku 4.5, the default
// caption model, and a rejected request would drop every line.
async function requestTranslation(
  apiKey: string,
  model: string,
  direction: CaptionDirection,
  trimmed: string,
): Promise<string> {
  const message = await anthropic(apiKey).messages.create({
    model,
    max_tokens: 256,
    system: buildCaptionTranslationPrompt(direction),
    messages: [{ role: "user", content: trimmed }],
  });
  return extractTranslation(message.content);
}

// "This key can't use this model" surfaces as a 404 or 403 — distinct from a
// 401 (bad key) or 429 (rate limit/transient). Only the former is rescued by
// switching models.
function isModelAccessError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

// Same fallback-latch behavior as the app's translateCaption: if the caption
// model (Haiku, cheap/fast) isn't accessible on this key, fall back to the
// main model and latch so later lines skip the doomed primary call.
let captionModelUnusable = false;

export async function translateCaption(
  config: Pick<AgentConfig, "anthropicApiKey" | "anthropicModel" | "captionTranslationModel">,
  text: string,
  direction: CaptionDirection,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fallbackModel = config.anthropicModel;
  const primaryModel = captionModelUnusable ? fallbackModel : config.captionTranslationModel;

  try {
    const out = await requestTranslation(config.anthropicApiKey, primaryModel, direction, trimmed);
    return out || null;
  } catch (err) {
    if (primaryModel !== fallbackModel && isModelAccessError(err)) {
      captionModelUnusable = true;
      logEvent("caption_model_fallback", {
        captionModel: config.captionTranslationModel,
        fallbackModel,
        status: (err as { status?: unknown }).status,
      });
      try {
        const out = await requestTranslation(
          config.anthropicApiKey,
          fallbackModel,
          direction,
          trimmed,
        );
        return out || null;
      } catch (fallbackErr) {
        logEvent("translate_error", { model: fallbackModel, error: String(fallbackErr) });
        return null;
      }
    }
    logEvent("translate_error", {
      model: primaryModel,
      error: String(err),
      status: (err as { status?: unknown } | null)?.status ?? null,
    });
    return null;
  }
}
