// Every place the product asks a model for words, and which of them an eval
// set measures (D-201). `tests/config/ai-evals.test.ts` holds this list to the
// tree: a file that sends a Messages request and is not here fails the gate,
// and the set of surfaces with no eval is a ratchet that may only shrink.
//
// A surface is one prompt shape — one builder, one parser, one place the
// output lands. A file can carry several.

import type { EvalSurface } from "./cases";

export type AiCallSite = {
  // Relative to apps/web.
  file: string;
  // Where the model id comes from, for the reader deciding what an eval run
  // measured (D-87 split these by call shape).
  model: string;
  // Every prompt shape the file sends.
  surfaces: readonly string[];
  // The subset with a case set under evals/cases/<surface>/ and a checker in
  // lib/evals/checks.ts. A name here must also be an EvalSurface.
  evaluated: readonly EvalSurface[];
};

export const AI_CALL_SITES: readonly AiCallSite[] = [
  {
    file: "src/lib/lesson-notes/insights.ts",
    model: "INSIGHTS_MODEL",
    surfaces: ["lesson-insights"],
    evaluated: ["lesson-insights"],
  },
  {
    file: "src/lib/ai/anthropic.ts",
    model: "anthropicModel()",
    surfaces: [
      "material-compose",
      "material-compose-stream",
      "material-refine",
      "podcast-script",
      "homework-review",
    ],
    evaluated: ["homework-review"],
  },
  {
    file: "src/lib/lesson-notes/summary.ts",
    model: "SUMMARY_MODEL",
    surfaces: ["lesson-summary"],
    evaluated: [],
  },
  {
    file: "src/lib/lesson-notes/brief.ts",
    model: "BRIEF_MODEL",
    surfaces: ["pre-class-brief"],
    evaluated: [],
  },
  {
    file: "src/lib/intro-video/coach.ts",
    model: "INTRO_COACH_MODEL",
    surfaces: ["intro-coach"],
    evaluated: [],
  },
  {
    file: "src/lib/marketing/content.ts",
    model: "anthropicModel()",
    surfaces: ["marketing-content"],
    evaluated: [],
  },
];

// The surfaces no eval set measures yet. Derived, so the registry cannot say
// one thing in `surfaces` and another here.
export function unevaluatedSurfaces(sites: readonly AiCallSite[] = AI_CALL_SITES): string[] {
  return sites
    .flatMap((site) =>
      site.surfaces.filter((s) => !(site.evaluated as readonly string[]).includes(s)),
    )
    .sort();
}
