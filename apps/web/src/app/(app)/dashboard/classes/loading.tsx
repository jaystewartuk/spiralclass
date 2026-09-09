import { PageShell } from "@/components/ui/page-shell";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * The roster's loading state.
 *
 * It mirrors the real screen's SHAPE — wide shell, two columns, toolbar,
 * one list card and an aside — because a skeleton that settles into a
 * different layout is a page that visibly jumps. The old one drew a narrow
 * single column and two equal cards, which is the layout this page had before
 * and no longer has.
 */
export default function ClassesLoading() {
  return (
    <PageShell width="wide">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-10 w-64" />
          </div>
          <div className="space-y-3 rounded-lg border p-4 lg:p-6">
            <Skeleton className="h-4 w-40" />
            <ListSkeleton count={5} rowClassName="h-14" />
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-3 rounded-lg border p-6">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </div>
    </PageShell>
  );
}
