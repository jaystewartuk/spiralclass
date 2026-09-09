import { PageShell } from "@/components/ui/page-shell";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * The discounts screen's loading state.
 *
 * It draws the LIST layout — wide shell, stats, list beside a rail — because
 * that is the shape a returning teacher lands on. The empty state is a
 * different, narrower page, and is seen once; settling from this into that is
 * a single jump on a first visit, where settling from a narrow placeholder
 * into the wide list would be a jump on every visit after it.
 */
export default function DiscountsLoading() {
  return (
    <PageShell width="wide">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-3 lg:col-span-2">
          <Skeleton className="h-5 w-16" />
          <div className="rounded-lg border p-4 lg:p-6">
            <ListSkeleton count={3} rowClassName="h-16" />
          </div>
        </div>
        <div className="space-y-3 rounded-lg border p-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    </PageShell>
  );
}
