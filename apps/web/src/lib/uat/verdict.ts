// Pure Go/No-Go verdict logic for /admin/uat, split out of uat-runbook.tsx so
// it's testable without rendering the whole wizard component. Computed live
// from what actually happened in the current session (checked items +
// automated-check results) — not a static list the tester has to manually
// reconcile against what they observed. A category that was never selected
// isn't "incomplete", it just wasn't run this pass.
import { UAT_SECTIONS, CATEGORY_LABELS, type UatCategory } from "./runbook-steps";

export type CategoryCoverage = { category: UatCategory; done: number; total: number };

export function computeCategoryBreakdown(
  selectedCategories: ReadonlySet<UatCategory>,
  checkedIds: ReadonlySet<string>,
): CategoryCoverage[] {
  return (Object.keys(CATEGORY_LABELS) as UatCategory[])
    .filter((c) => selectedCategories.has(c))
    .map((cat) => {
      const items = UAT_SECTIONS.filter((s) => s.category === cat).flatMap((s) => s.items);
      const done = items.filter((i) => checkedIds.has(i.id)).length;
      return { category: cat, done, total: items.length };
    });
}

export type UatVerdict = "GO" | "NO_GO" | "INCOMPLETE";

// `anyAutomatedFailure`: true if any automated check (probe/PostHog/Stripe)
// that actually ran came back FAIL or errored. An automated check that never
// ran doesn't count against the verdict — same "not selected isn't
// incomplete" logic as categories.
export function computeVerdict(
  categoryBreakdown: CategoryCoverage[],
  anyAutomatedFailure: boolean,
): UatVerdict {
  if (anyAutomatedFailure) return "NO_GO";
  if (categoryBreakdown.some((c) => c.total > 0 && c.done < c.total)) return "INCOMPLETE";
  return "GO";
}
