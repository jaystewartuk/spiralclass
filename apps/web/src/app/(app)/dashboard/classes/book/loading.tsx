import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The booking screen's loading state.
 *
 * There was none, and this route needs one more than most: every day, month
 * and package on it is a server round trip, so without a skeleton the whole
 * page went blank on each of them.
 *
 * It draws the WIDE two-pane shape — the day-and-time step, which is where a
 * teacher spends the flow and the only step slow enough to be seen. The
 * student picker settles into a narrower column and will shift; that is the
 * better of the two trades, because the picker is a single fast query and the
 * skeleton is mostly not shown for it at all.
 */
export default function BookLoading() {
  return (
    <PageShell width="wide">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-11 w-40 lg:h-10" />
      </div>

      {/* The context card: student, then package. */}
      <div className="space-y-4 rounded-lg border p-4 lg:p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-40" />
          </div>
        </div>
        <div className="space-y-2 border-t pt-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-52" />
        </div>
      </div>

      <div className="grid rounded-lg border lg:grid-cols-5">
        <div className="space-y-3 p-4 lg:col-span-2 lg:p-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-6 w-36" />
          {/* Six rows of seven — the month grid's own shape. */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 42 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
        <div className="space-y-4 border-t p-4 lg:col-span-3 lg:border-t-0 lg:border-l lg:p-6">
          <Skeleton className="h-5 w-56" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Array.from({ length: 9 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
