import { PageShell } from "@/components/ui/page-shell";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * The payments screen's shape, before it has any content.
 *
 * Matched to the real layout — header, the money card, the view/search bar,
 * one month of rows — because a skeleton that does not match reflows the page
 * the moment it resolves, which reads as a glitch rather than as loading. The
 * confirm queue is deliberately absent: it is present only when there is a job
 * waiting, and drawing a placeholder for it would promise one on every load.
 */
export default function PaymentsLoading() {
  return (
    <PageShell width="wide">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      {/* Money card: four figures across. */}
      <Skeleton className="h-44 w-full rounded-lg" />

      <div className="space-y-4">
        <Skeleton className="h-7 w-24" />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Skeleton className="h-10 w-72 max-w-full" />
          <Skeleton className="h-10 w-64 max-w-full" />
        </div>
        <Skeleton className="h-6 w-40" />
        <ListSkeleton count={8} rowClassName="h-14" />
      </div>
    </PageShell>
  );
}
