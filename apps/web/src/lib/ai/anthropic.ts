import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey, anthropicModel, hasAnthropicCreds } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  CLASS_CONTENT_MAX_CHARS,
  MATERIAL_MAX_OUTPUT_TOKENS,
  MaterialIncompleteError,
  PODCAST_SCRIPT_MAX_CHARS,
} from "@/lib/materials/config";
import {
  buildMaterialPrompt,
  buildMaterialRefinePrompt,
  type MaterialPromptInput,
  type MaterialRefinePromptInput,
} from "@/lib/materials/prompt";
import { buildPodcastScriptPrompt, type PodcastPromptInput } from "@/lib/materials/podcast-prompt";
import {
  AI_REVIEW_TOOL,
  buildAiReviewPrompt,
  parseAiReviewToolInput,
  type AiReviewPromptInput,
} from "@/lib/homework/ai-review-prompt";
import type { HomeworkAiReviewContent } from "@spiralclass/shared";

const log = logger({ surface: "ai" });

// In-house Claude integration for material compose (D-17, generalized by the
// ClassContent/LibraryMaterial merge: one call path for both a single
// class's content and a standalone reusable material). Routed through the
// PLATFORM Anthropic key only — never per-teacher, never entangled with the
// Connect payout rail. The client is constructed lazily so the module imports
// cleanly when no key is configured (dev/tests), and callers gate on
// hasAnthropicCreds() before reaching here.

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: anthropicApiKey() });
  }
  return client;
}

export type GenerateMaterialResult =
  | { ok: true; body: string }
  | { ok: false; reason: "not-configured" | "empty" | "truncated" | "error" };

// One long-form call: streamed under the hood because a call this size can run
// for minutes, collected into the final message. Returns the text together with
// why the model stopped, because a response cut off by max_tokens is a
// successful HTTP call carrying half a document.
async function composeText(
  system: string,
  user: string,
): Promise<{ text: string; stopReason: Anthropic.Message["stop_reason"] }> {
  const message = await anthropic()
    .messages.stream({
      model: anthropicModel(),
      max_tokens: MATERIAL_MAX_OUTPUT_TOKENS,
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    })
    .finalMessage();

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { text, stopReason: message.stop_reason };
}

// A body is only ever returned whole. Slicing an over-long one to the ceiling
// would hand the teacher the same cut-off document as running out of tokens.
async function composeMaterialBody(system: string, user: string): Promise<GenerateMaterialResult> {
  const { text, stopReason } = await composeText(system, user);
  if (stopReason === "max_tokens" || text.length > CLASS_CONTENT_MAX_CHARS) {
    log.warn("material output did not fit", { stopReason, chars: text.length });
    return { ok: false, reason: "truncated" };
  }
  if (!text) return { ok: false, reason: "empty" };
  // A refusal part-way through is also not a finished document.
  if (stopReason !== "end_turn") {
    log.warn("material output stopped early", { stopReason, chars: text.length });
    return { ok: false, reason: "error" };
  }
  return { ok: true, body: text };
}

// Generate a material's Markdown body — either a single class's content
// (forClass: true) or a standalone reusable library item (forClass: false).
// Returns the raw Markdown for the teacher to review and edit before saving —
// this never writes to the DB. A body that does not fit comes back as
// "truncated", never cut; the saved body is re-validated on the way in.
export async function generateMaterial(
  input: MaterialPromptInput,
): Promise<GenerateMaterialResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const { system, user } = buildMaterialPrompt(input);

  try {
    // effort "medium" balances quality against token spend
    // (docs/deployment/COST_PLAYBOOK.md).
    return await composeMaterialBody(system, user);
  } catch (err) {
    log.error("material generation failed", err);
    return { ok: false, reason: "error" };
  }
}

// "Edit with AI" — apply a teacher's free-text change to an existing material's
// Markdown body and return the full revised document. The refine counterpart of
// generateMaterial: same platform client, same cap/effort, same result shape;
// a different prompt (buildMaterialRefinePrompt) that carries the current body +
// the instruction. Like generateMaterial this NEVER writes to the DB and does
// not enforce the monthly cap — the caller gates + records the quota.
export async function refineMaterial(
  input: MaterialRefinePromptInput,
): Promise<GenerateMaterialResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const { system, user } = buildMaterialRefinePrompt(input);

  try {
    return await composeMaterialBody(system, user);
  } catch (err) {
    log.error("material refine failed", err);
    return { ok: false, reason: "error" };
  }
}

export type GeneratePodcastScriptResult =
  | { ok: true; script: string }
  | { ok: false; reason: "not-configured" | "empty" | "truncated" | "error" };

// Generate the spoken monologue a material's podcast narrates — the text half
// of podcast generation, before ElevenLabs renders it to audio. Same platform
// Claude client as generateMaterial, a different prompt (buildPodcastScriptPrompt):
// natural spoken prose, no Markdown. Bounded by PODCAST_SCRIPT_MAX_CHARS on the
// way out so the TTS call (also capped there) never truncates mid-sentence.
export async function generatePodcastScript(
  input: PodcastPromptInput,
): Promise<GeneratePodcastScriptResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const { system, user } = buildPodcastScriptPrompt(input);

  try {
    const { text: script, stopReason } = await composeText(system, user);
    if (stopReason === "max_tokens") return { ok: false, reason: "truncated" };
    if (!script) return { ok: false, reason: "empty" };
    return { ok: true, script: script.slice(0, PODCAST_SCRIPT_MAX_CHARS) };
  } catch (err) {
    log.error("podcast script generation failed", err);
    return { ok: false, reason: "error" };
  }
}

export type GenerateHomeworkAiReviewResult =
  | { ok: true; content: HomeworkAiReviewContent }
  | { ok: false; reason: "not-configured" | "empty" | "error" };

// Homework "Review with AI" (docs/features/homework.md). Same
// platform Claude client as generateMaterial, but a forced tool call
// (mirrors lib/lesson-notes/insights.ts) so the response is validated
// structure, never prose to re-parse. Never writes to the DB and does not
// enforce the monthly cap — the caller gates + records the quota.
export async function generateHomeworkAiReview(
  input: AiReviewPromptInput,
): Promise<GenerateHomeworkAiReviewResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const { system, user } = buildAiReviewPrompt(input);

  try {
    const message = await anthropic().messages.create({
      model: anthropicModel(),
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
      tools: [AI_REVIEW_TOOL],
      tool_choice: { type: "tool", name: AI_REVIEW_TOOL.name },
    });

    const toolUse = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === AI_REVIEW_TOOL.name,
    );
    if (!toolUse) return { ok: false, reason: "empty" };

    const content = parseAiReviewToolInput(toolUse.input);
    if (!content) return { ok: false, reason: "empty" };
    return { ok: true, content };
  } catch (err) {
    log.error("homework AI review failed", err);
    return { ok: false, reason: "error" };
  }
}

// Streaming variant for the "watch it write" live-generation UI: yields
// Markdown text deltas as the model produces them. Throws Error("not-configured")
// when no creds; a mid-stream provider failure surfaces as an iterator throw the
// caller catches, including MaterialIncompleteError when the model ran out of
// room, because the deltas already sent are then only the front of a document.
// Like generateMaterial this NEVER writes to the DB and does not
// enforce the monthly cap — the route gates before starting and records the
// quota only on successful completion.
export async function* generateMaterialStream(
  input: MaterialPromptInput,
): AsyncGenerator<string, void, unknown> {
  if (!hasAnthropicCreds()) throw new Error("not-configured");

  const { system, user } = buildMaterialPrompt(input);
  const stream = anthropic().messages.stream({
    model: anthropicModel(),
    max_tokens: MATERIAL_MAX_OUTPUT_TOKENS,
    output_config: { effort: "medium" },
    system,
    messages: [{ role: "user", content: user }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const { stop_reason: stopReason } = await stream.finalMessage();
  if (stopReason === "max_tokens") throw new MaterialIncompleteError();
  if (stopReason !== "end_turn") throw new Error(`material stream stopped: ${stopReason}`);
}
