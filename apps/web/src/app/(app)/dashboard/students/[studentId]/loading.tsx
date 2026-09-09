import { PageShell } from "@/components/ui/page-shell";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * The shape of the student screen while it loads: back link, identity block,
 * the four-tile glance strip, the tab row, then the two-column body.
 *
 * It mirrors the real layout rather than showing generic bars, so the page
 * does not visibly rearrange itself when the data lands.
 */
export default function StudentDetailLoading() {
  return (
    <PageShell width="wide">
      <Skeleton className="h-4 w-32" />

      <div className="flex flex-wrap items-start gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="flex-1 basis-64 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-11 w-32" />
          <Skeleton className="h-11 w-28" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 px-4 py-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>

      <div className="flex gap-4 border-b pb-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-20" />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 rounded-lg border p-6 lg:col-span-2">
          <Skeleton className="h-5 w-40" />
          <ListSkeleton count={4} />
        </div>
        <div className="space-y-4 rounded-lg border p-6">
          <Skeleton className="h-5 w-32" />
          <ListSkeleton count={3} />
        </div>
      </div>
    </PageShell>
  );
}
