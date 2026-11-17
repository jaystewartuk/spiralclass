// Which Claude model each AI surface runs on, and the check that keeps an env
// override from naming one its calls would 400 on (D-87, issue #30).
//
// Pure — no env, no logger — so the offline eval runner (scripts/evals.ts),
// which cannot load lib/env.ts, reads the same defaults instead of restating
// them. lib/env.ts is the only caller that reads the environment.
//
// Two tiers, split by call shape exactly as D-87 split them:
//
//   * "standard" — ANTHROPIC_MODEL, via anthropicModel(). Material compose,
//     refine, podcast script (all pass `output_config.effort`), plus the
//     homework review draft and acquisition content (forced tool calls).
//   * "small" — ANTHROPIC_SMALL_MODEL, via anthropicSmallModel(). The four
//     short structured calls: lesson summary, lesson insights, pre-class brief,
//     intro-video coach. None passes `effort`; insights and brief force a tool.
//
// One variable moves a whole tier, so a rollback is an env change rather than
// a release. A value naming a model whose capabilities are not recorded below,
// or one missing a capability its tier's calls use, is refused and the tier's
// default is used instead. That fallback is the point: the trap D-87 recorded
// is an override that type-checks, deploys and then 400s every call.

export type ModelCapability =
  // Accepts `output_config.effort`. The API rejects it with a 400 on models
  // before 4.6 (Haiku 4.5, Sonnet 4.5); Opus 4.5 is the exception.
  | "effort"
  // Accepts `tool_choice: { type: "tool" }` alongside the default thinking
  // setting. Opus 5.5, Sonnet 5.5 and Fable 5.1+ reject a forced tool choice
  // with a 400, so they are deliberately absent from the table below.
  | "forcedToolChoice";

// A model is listed only once every capability named for it has been
// confirmed. Absent means unconfirmed, and unconfirmed is refused: adding a
// model here is a deliberate one-line change that D-201 asks to arrive with an
// eval run, while REVERTING to a model already here is the env change the
// escape hatch exists for.
export const MODEL_CAPABILITIES: Readonly<Record<string, readonly ModelCapability[]>> = {
  "claude-haiku-4-5": ["forcedToolChoice"],
  "claude-sonnet-4-5": ["forcedToolChoice"],
  "claude-opus-4-5": ["effort", "forcedToolChoice"],
  "claude-opus-4-6": ["effort", "forcedToolChoice"],
  "claude-opus-4-7": ["effort", "forcedToolChoice"],
  "claude-opus-4-8": ["effort", "forcedToolChoice"],
  "claude-sonnet-4-6": ["effort", "forcedToolChoice"],
  "claude-sonnet-5": ["effort", "forcedToolChoice"],
};

export type ModelTier = "standard" | "small";

// The production defaults (D-87). Changing one is a model change, and D-201
// asks for a before-and-after eval run in the PR that makes it.
export const MODEL_TIER_DEFAULTS: Readonly<Record<ModelTier, string>> = {
  standard: "claude-sonnet-5",
  small: "claude-haiku-4-5",
};

// What each tier's call sites send, and so what any model in it must accept.
export const MODEL_TIER_REQUIRES: Readonly<Record<ModelTier, readonly ModelCapability[]>> = {
  standard: ["effort", "forcedToolChoice"],
  small: ["forcedToolChoice"],
};

export type ModelResolution =
  | { model: string; refused: null }
  // The override could not be used; `model` is the tier default.
  | { model: string; refused: { value: string; missing: readonly ModelCapability[] | "unknown" } };

// Resolve a tier's model from an optional override (already trimmed of
// blanks by the env schema). Never throws: a bad value degrades to the default.
export function resolveTierModel(tier: ModelTier, override: string | undefined): ModelResolution {
  const fallback = MODEL_TIER_DEFAULTS[tier];
  const value = override?.trim();
  if (!value) return { model: fallback, refused: null };

  const capabilities = MODEL_CAPABILITIES[value];
  if (!capabilities) return { model: fallback, refused: { value, missing: "unknown" } };

  const missing = MODEL_TIER_REQUIRES[tier].filter((c) => !capabilities.includes(c));
  if (missing.length > 0) return { model: fallback, refused: { value, missing } };

  return { model: value, refused: null };
}
