import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";

/**
 * Mirrors the real layout in dashboard-view.tsx — two columns above `lg`, a
 * schedule card leading the main one, the shortcut grid at the foot. A
 * skeleton whose shape disagrees with what arrives makes the page appear to
 * jump when it loads, which is worse than no skeleton at all.
 */
export default function DashboardLoading() {
  return (
    <PageShell width="wide">
      {/* Greeting + primary action */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          {/* Schedule card */}
          <div className="space-y-4 rounded-lg border p-6">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-64" />
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-24 shrink-0" />
                  <Skeleton className="h-10 flex-1" />
                </div>
              ))}
            </div>
          </div>

          {/* Growth checklist */}
          <div className="space-y-3 rounded-lg border p-6">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-1.5 w-full" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {/* Money */}
          <div className="space-y-3 rounded-lg border p-6">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
          {/* Booking link */}
          <div className="space-y-3 rounded-lg border p-6">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-9 w-full" />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-36" />
            </div>
          </div>
          {/* Payments status line */}
          <Skeleton className="h-16 w-full" />
        </div>
      </div>

      {/* Shortcut grid */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
