import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

// Shaped like the page it stands in for, rather than like a generic list: the
// header block, the search field and filter chips, then a titled section of
// rows that each carry an icon tile, a title and a meta line. A placeholder
// whose proportions do not match what arrives is a layout shift with extra
// steps.

function RowSkeleton() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
      <Skeleton className="size-10 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    </div>
  );
}

export default function StudentMaterialsLoading() {
  return (
    <PageShell width="reading">
      {/* Title, subtitle and the level badge that sits beside them. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      {/* Search, then the source chips. */}
      <div className="space-y-3">
        <Skeleton className="h-11 w-full" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="min-h-target w-24 rounded-full" />
          <Skeleton className="min-h-target w-36 rounded-full" />
          <Skeleton className="min-h-target w-32 rounded-full" />
        </div>
      </div>

      <div
        className="flex flex-col gap-3 border-t border-border pt-5"
        role="status"
        aria-busy="true"
      >
        <Skeleton className="h-5 w-32" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
