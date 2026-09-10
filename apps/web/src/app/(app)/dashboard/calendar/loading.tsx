import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";

/**
 * The calendar's skeleton, matched to what actually renders.
 *
 * It was drawing 35 SQUARE cells inside a padded box, with no view switcher
 * and no agenda — a shape the page has never had — so the hand-off from
 * skeleton to content moved everything on screen. Cells are `min-h-cell-lg`
 * here for the same reason they are there, the switcher is reserved, and the
 * agenda beneath it is the panel the month view always shows.
 */
export default function CalendarLoading() {
  return (
    <PageShell width="wide" className="py-8 lg:py-10">
      {/* Title + actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* View switcher */}
      <Skeleton className="h-12 w-full max-w-xs rounded-lg" />

      {/* Range header */}
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-11 w-40 rounded-lg" />
      </div>

      {/* Month grid */}
      <div className="overflow-hidden rounded-lg border">
        <Skeleton className="h-10 w-full rounded-none" />
        <div className="bg-border grid grid-cols-7 gap-px">
          {Array.from({ length: 35 }).map((_, i) => (
            <Skeleton key={i} className="min-h-cell sm:min-h-cell-lg rounded-none" />
          ))}
        </div>
      </div>

      {/* Selected-day agenda */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-44" />
        <div className="space-y-px overflow-hidden rounded-lg border">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-none" />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
