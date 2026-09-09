import type { PaletteToken } from "../tokens";
import type { StringKey } from "../i18n/index";
import type { CalloutVariant } from "./types";

// The shared semantics of each callout variant — the ONE table every renderer
// (web, mobile, PDF) reads so a "tip" is the same green lightbulb everywhere and
// a "warning" the same amber triangle. Renderers do NOT hardcode per-variant
// colours; they look them up here and derive their own tinted background /
// border from the role colour (a subtle alpha wash — see each renderer), so the
// treatment stays consistent yet on-brand in both light and dark themes.
//
// `role` is a key into the brand palette (packages/shared/src/tokens.ts) — the
// strong accent colour for the callout's icon, border and label. Backgrounds
// are a low-opacity tint of that same colour, computed per platform, so no new
// design tokens are needed and dark mode switches for free.
//
// `icon` is a lucide icon name — the SAME set exists as `lucide-react` (web) and
// the PDF renderer, which has no icon runtime,
// falls back to the coloured label alone.
//
// `labelKey` is a shared-catalog i18n key (both platforms draw from it), used
// when the author didn't supply an inline title after the `[!variant]` marker.

export type CalloutMeta = {
  role: PaletteToken;
  icon: string;
  labelKey: StringKey;
};

export const CALLOUT_META: Record<CalloutVariant, CalloutMeta> = {
  note: { role: "borderStrong", icon: "StickyNote", labelKey: "material.callout.note" },
  info: { role: "info", icon: "Info", labelKey: "material.callout.info" },
  tip: { role: "success", icon: "Lightbulb", labelKey: "material.callout.tip" },
  important: { role: "danger", icon: "CircleAlert", labelKey: "material.callout.important" },
  warning: { role: "warning", icon: "TriangleAlert", labelKey: "material.callout.warning" },
  remember: { role: "accent", icon: "Pin", labelKey: "material.callout.remember" },
  example: { role: "sage", icon: "BookOpen", labelKey: "material.callout.example" },
  exercise: { role: "clay", icon: "PencilLine", labelKey: "material.callout.exercise" },
  question: { role: "info", icon: "CircleHelp", labelKey: "material.callout.question" },
  answer: { role: "success", icon: "CircleCheck", labelKey: "material.callout.answer" },
  vocabulary: { role: "accent", icon: "BookMarked", labelKey: "material.callout.vocabulary" },
  grammar: { role: "primary", icon: "Languages", labelKey: "material.callout.grammar" },
  summary: { role: "sage", icon: "ListChecks", labelKey: "material.callout.summary" },
  homework: { role: "clay", icon: "House", labelKey: "material.callout.homework" },
};

// Variants whose answer content should render de-emphasised / collapsible so it
// never dominates the exercise flow during a live lesson (the Q&A requirement).
export const COLLAPSIBLE_CALLOUTS: ReadonlySet<CalloutVariant> = new Set(["answer"]);

// Variants that ARE the answer key — the solutions a teacher holds back from
// the student's copy of a material. On screen these are the ones a renderer
// hides behind a "Show answer" toggle (COLLAPSIBLE_CALLOUTS above, the same set
// today); in a rendered export, where there is no toggle, they are cut from the
// document entirely — see ./answer-key.ts. The two sets are declared separately
// because they answer different questions ("render this quietly" vs. "this must
// not reach a student"), and a future variant can easily belong to one and not
// the other.
export const ANSWER_KEY_CALLOUTS: ReadonlySet<CalloutVariant> = new Set(["answer"]);

export function calloutMeta(variant: CalloutVariant): CalloutMeta {
  return CALLOUT_META[variant];
}
