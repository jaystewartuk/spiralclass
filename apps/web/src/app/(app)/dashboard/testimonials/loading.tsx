import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the real screen: title row with the "view your page" action, the
 * folded add button, the list heading with its count chips, then three quote
 * cards. A skeleton whose shape disagrees with what arrives makes the page
 * appear to jump when it loads, which is worse than no skeleton at all.
 */
export default function TestimonialsLoading() {
  return (
    <PageShell width="default">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      <Skeleton className="h-11 w-48" />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-6 w-28" />
      </div>

      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-lg border p-4 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-10 w-20" />
            </div>
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <div className="flex items-center gap-2 pt-1">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
