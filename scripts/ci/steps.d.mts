// Types for the local gate's step registry (scripts/ci/steps.mjs). Kept as a
// sibling declaration so the module stays a plain runnable .mjs — `node
// scripts/ci/gate.mjs` must work with no build step — while the guard test
// (apps/web/tests/config/local-gate.test.ts) imports it with full types.

export interface Step {
  /** CLI handle for --only / --skip. */
  id: string;
  title: string;
  /** Which HALF the step is in — not which tier selects it. */
  tier: "fast" | "heavy";
  /** argv, run from the repo root. */
  cmd: string[];
  /**
   * The GitHub Actions job this step took over from. PROVENANCE ONLY — every
   * workflow in this repo was deleted by D-129, so nothing checks that the file
   * named here exists. It is what makes the shape of a check readable later.
   */
  replaces: string;
  /** External prerequisites, e.g. "docker". */
  needs?: string[];
  env?: Record<string, string>;
}

export const STEPS: Step[];
export const TIERS: readonly ["fast", "heavy", "full"];

/** Steps in a tier — `fast` and `heavy` are the halves, `full` is both (D-161). */
export function stepsForTier(tier: string): Step[];
