import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors page.tsx — header and section nav, the week's progress line, then two
 * columns above `lg` with the next action leading the main one.
 *
 * Worth having here specifically: the first visit of a week does not just read
 * rows, it BUILDS the plan (`ensureWeeklyPlan` inserts an activity per action),
 * so this is one of the slower screens in the teacher app on exactly the visit
 * that matters most. A skeleton whose shape disagrees with what arrives makes
 * the page appear to jump when it loads, which is worse than no skeleton at
 * all — so the widths below are the real ones.
 */
export default function GetStudentsLoading() {
  return (
    <PageShell width="wide">
      {/* Title + "Rebuild the plan" */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      {/* Section nav */}
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-28" />
        ))}
      </div>

      {/* Week progress */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-1.5 w-full" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          {/* "Do this next" — heading plus the hero card */}
          <div className="space-y-3">
            <Skeleton className="h-5 w-32" />
            <div className="space-y-4 rounded-lg border p-6">
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-6 w-24" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-2/3" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-11 w-28" />
                <Skeleton className="h-11 w-32" />
              </div>
            </div>
          </div>

          {/* "The rest of this week" — heading plus the divided list */}
          <div className="space-y-3">
            <Skeleton className="h-5 w-44" />
            <div className="divide-y divide-border rounded-lg border">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-6 py-3">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-64" />
                  </div>
                  <Skeleton className="h-11 w-11 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          {/* Last 30 days */}
          <div className="space-y-4 rounded-lg border p-6">
            <Skeleton className="h-5 w-32" />
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-7 w-10" />
                </div>
              ))}
            </div>
            <Skeleton className="h-10 w-36" />
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
