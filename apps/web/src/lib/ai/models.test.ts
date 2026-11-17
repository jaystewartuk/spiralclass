import { describe, expect, it } from "vitest";
import {
  MODEL_CAPABILITIES,
  MODEL_TIER_DEFAULTS,
  MODEL_TIER_REQUIRES,
  resolveTierModel,
  type ModelTier,
} from "./models";

const TIERS: ModelTier[] = ["standard", "small"];

describe("tier defaults", () => {
  // D-87's choice. A change here is a model change and quotes an eval run
  // (D-201); this pins that nothing moved it by accident.
  it("are the models D-87 chose", () => {
    expect(MODEL_TIER_DEFAULTS).toEqual({
      standard: "claude-sonnet-5",
      small: "claude-haiku-4-5",
    });
  });

  // The invariant D-87 states: every call in a tier must run on its default.
  // A default that lacked `effort` would 400 every material generation.
  it.each(TIERS)("%s default has every capability its tier's calls use", (tier) => {
    const capabilities = MODEL_CAPABILITIES[MODEL_TIER_DEFAULTS[tier]];
    expect(capabilities).toBeDefined();
    for (const needed of MODEL_TIER_REQUIRES[tier]) expect(capabilities).toContain(needed);
  });

  it("resolves to the default with no override", () => {
    for (const tier of TIERS) {
      expect(resolveTierModel(tier, undefined)).toEqual({
        model: MODEL_TIER_DEFAULTS[tier],
        refused: null,
      });
      expect(resolveTierModel(tier, "   ").model).toBe(MODEL_TIER_DEFAULTS[tier]);
    }
  });
});

describe("resolveTierModel", () => {
  it("uses an override that has its tier's capabilities", () => {
    expect(resolveTierModel("standard", "claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      refused: null,
    });
    expect(resolveTierModel("small", "claude-sonnet-5")).toEqual({
      model: "claude-sonnet-5",
      refused: null,
    });
  });

  // The trap from D-87: ANTHROPIC_MODEL=claude-haiku-4-5 400'd every compose call.
  it("refuses a pre-4.6 model on the effort-passing tier", () => {
    expect(resolveTierModel("standard", "claude-haiku-4-5")).toEqual({
      model: "claude-sonnet-5",
      refused: { value: "claude-haiku-4-5", missing: ["effort"] },
    });
  });

  it("accepts the same model on the tier that passes no effort", () => {
    expect(resolveTierModel("small", "claude-haiku-4-5").refused).toBeNull();
  });

  // Unconfirmed is refused: a typo, or a model whose forced-tool-choice
  // behaviour is not recorded (Opus 5.5 and Sonnet 5.5 reject it).
  it.each(["claude-typo", "claude-opus-5-5", "claude-sonnet-5-5"])(
    "refuses %s, which has no capability record",
    (value) => {
      for (const tier of TIERS) {
        expect(resolveTierModel(tier, value)).toEqual({
          model: MODEL_TIER_DEFAULTS[tier],
          refused: { value, missing: "unknown" },
        });
      }
    },
  );

  it("trims surrounding whitespace before looking a value up", () => {
    expect(resolveTierModel("small", " claude-sonnet-5 ").model).toBe("claude-sonnet-5");
  });
});
