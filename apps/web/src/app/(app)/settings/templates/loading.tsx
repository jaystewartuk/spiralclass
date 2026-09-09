import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * The packages screen's loading state.
 *
 * It draws the COLLAPSED list — a header, the count-and-add row, then one
 * short card per package — because that is the shape the page settles into:
 * every row starts closed, so a placeholder built from tall open editors would
 * collapse on arrival and move everything under it.
 *
 * No `PageShell` here: the settings layout already supplies the container and
 * its vertical rhythm, and a second shell would indent the page inside itself.
 */
export default function PackagesLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full max-w-prose" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
        <ListSkeleton count={4} rowClassName="h-20 rounded-lg" />
      </div>
    </div>
  );
}
