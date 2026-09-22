import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey, anthropicModel, hasAnthropicCreds } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CLASS_CONTENT_MAX_CHARS, PODCAST_SCRIPT_MAX_CHARS } from "@/lib/materials/config";
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
// ClassContent/LibraryMaterial merge — D-69: one call path for both a single
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
  { ok: true; body: string } | { ok: false; reason: "not-configured" | "empty" | "error" };

// Generate a material's Markdown body — either a single class's content
// (forClass: true) or a standalone reusable library item (forClass: false).
// Returns the raw Markdown for the teacher to review and edit before saving —
// this never writes to the DB. Output is bounded by max_tokens; the saved
// body is re-validated against the same ceiling on the way in.
export async function generateMaterial(
  input: MaterialPromptInput,
): Promise<GenerateMaterialResult> {
  if (!hasAnthropicCreds()) return { ok: false, reason: "not-configured" };

  const { system, user } = buildMaterialPrompt(input);

  try {
    // Non-streaming: a single class's content fits comfortably under this cap,
    // and the cap keeps generation (and cost) bounded. effort "medium" balances
    // quality against token spend (docs/deployment/COST_PLAYBOOK.md).
    const message = await anthropic().messages.create({
      model: anthropicModel(),
      max_tokens: 4096,
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    });

    const body = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!body) return { ok: false, reason: "empty" };
    return { ok: true, body: body.slice(0, CLASS_CONTENT_MAX_CHARS) };
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
    const message = await anthropic().messages.create({
      model: anthropicModel(),
      max_tokens: 4096,
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    });

    const body = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!body) return { ok: false, reason: "empty" };
    return { ok: true, body: body.slice(0, CLASS_CONTENT_MAX_CHARS) };
  } catch (err) {
    log.error("material refine failed", err);
    return { ok: false, reason: "error" };
  }
}

export type GeneratePodcastScriptResult =
  { ok: true; script: string } | { ok: false; reason: "not-configured" | "empty" | "error" };

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
    const message = await anthropic().messages.create({
      model: anthropicModel(),
      max_tokens: 4096,
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    });

    const script = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

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
// caller catches. Like generateMaterial this NEVER writes to the DB and does not
// enforce the monthly cap — the route gates before starting and records the
// quota only on successful completion.
export async function* generateMaterialStream(
  input: MaterialPromptInput,
): AsyncGenerator<string, void, unknown> {
  if (!hasAnthropicCreds()) throw new Error("not-configured");

  const { system, user } = buildMaterialPrompt(input);
  const stream = anthropic().messages.stream({
    model: anthropicModel(),
    max_tokens: 4096,
    output_config: { effort: "medium" },
    system,
    messages: [{ role: "user", content: user }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
