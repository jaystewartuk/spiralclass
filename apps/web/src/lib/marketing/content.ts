import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  contentKindSpec,
  platformSpec,
  type MarketingContentKind,
  type MarketingPlatform,
  type PromoPolicy,
} from "@spiralclass/shared";
import { anthropicApiKey, anthropicModel, hasAnthropicCreds } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import {
  buildContentSystemPrompt,
  buildContentUserPrompt,
  type ContentPromptInput,
} from "./prompt";

const log = logger({ surface: "marketing" });

// Marketing-content generation (D-125).
//
// Routed through the PLATFORM Anthropic key only — never per-teacher, never
// entangled with the Connect payout rail — exactly like the material composer
// this is modelled on (lib/ai/anthropic.ts). Structured output via forced tool
// use, so a post arrives as fields rather than as prose we then have to parse.
//
// Deliberately its OWN module rather than a fifth function on lib/ai/anthropic:
// that file is the teaching-material rail, and mixing an acquisition surface
// into it would make one prompt regression capable of breaking both.

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: anthropicApiKey() });
  return client;
}

export const MARKETING_CONTENT_TOOL: Anthropic.Tool = {
  name: "emit_marketing_post",
  description:
    "Emit the finished post. Use only the facts supplied. Never invent students, results, prices or testimonials.",
  input_schema: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description: "The post itself, ready to paste. Plain text with line breaks.",
      },
      title: {
        type: "string",
        description:
          "A title/hook, only where the platform uses one (a Reddit post title). Omit otherwise.",
      },
      angleNote: {
        type: "string",
        description:
          "One short sentence for the teacher explaining the angle you took, so she can judge it at a glance.",
      },
      imageIdea: {
        type: "string",
        description:
          "If an image would help, a short visual description with NO text or letters in it. Omit if an image adds nothing.",
      },
    },
    required: ["body", "angleNote"],
  },
};

const toolInputSchema = z.object({
  body: z.string().trim().min(1),
  title: z.string().trim().min(1).nullish(),
  angleNote: z.string().trim().min(1),
  imageIdea: z.string().trim().min(1).nullish(),
});

export type GeneratedContent = {
  body: string;
  title: string | null;
  angleNote: string;
  imageIdea: string | null;
};

export type GenerateContentResult =
  | { ok: true; content: GeneratedContent }
  | {
      ok: false;
      reason: "not-configured" | "throttled" | "empty" | "error";
      retryAfterMs?: number;
    };

/**
 * A bad minute costs real money and a teacher never needs this many drafts in
 * one sitting. Sized above deliberate "try another angle" use (which is the
 * point of the feature) and far below anything automated.
 */
const GENERATE_RATE_LIMIT = { scope: "marketing-content", limit: 15, windowMs: 10 * 60_000 };

export async function generateMarketingContent(
  input: ContentPromptInput & { teacherId: string },
): Promise<GenerateContentResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const throttle = await rateLimit(input.teacherId, GENERATE_RATE_LIMIT);
  if (!throttle.ok) {
    return { ok: false, reason: "throttled", retryAfterMs: throttle.retryAfterMs };
  }

  const system = buildContentSystemPrompt(input);
  const user = buildContentUserPrompt(input);

  try {
    const message = await anthropic().messages.create({
      model: anthropicModel(),
      // A social post is short. The ceiling is generous enough for a Reddit
      // comment and mean enough that a runaway generation costs cents.
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
      tools: [MARKETING_CONTENT_TOOL],
      tool_choice: { type: "tool", name: MARKETING_CONTENT_TOOL.name },
    });

    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === MARKETING_CONTENT_TOOL.name,
    );
    if (!toolUse) return { ok: false, reason: "empty" };

    const parsed = toolInputSchema.safeParse(toolUse.input);
    if (!parsed.success) return { ok: false, reason: "empty" };

    const kind = contentKindSpec(input.kind);
    const platform = platformSpec(input.platform);
    // A generous ceiling over the platform's soft limit: the prompt asks for
    // brevity, this stops a runaway from reaching the teacher's clipboard.
    const bodyCap = platform.maxChars * 2;

    return {
      ok: true,
      content: {
        body: parsed.data.body.slice(0, bodyCap),
        title: parsed.data.title?.slice(0, 200) ?? null,
        angleNote: parsed.data.angleNote.slice(0, 300),
        // Only surface an image idea when this kind actually wants one — the
        // model volunteering one for a Reddit comment is noise.
        imageIdea: kind.wantsImage ? (parsed.data.imageIdea?.slice(0, 400) ?? null) : null,
      },
    };
  } catch (err) {
    log.error("marketing content generation failed", err);
    return { ok: false, reason: "error" };
  }
}

export type ContentRequest = {
  teacherId: string;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
};
