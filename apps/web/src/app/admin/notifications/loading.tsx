import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "@/components/ui/skeleton";

export default function AdminNotificationsLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Stats row */}
      <div className="grid gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1 rounded-md border p-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      {/* Recent notifications section */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-44" />

        {/* Filter bar */}
        <div className="bg-muted/30 space-y-3 rounded-md border p-4">
          <div className="grid gap-3 lg:grid-cols-4">
            <div className="space-y-1 lg:col-span-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-md border">
          <div className="p-3">
            <Skeleton className="mb-1 h-8 w-full" />
          </div>
          <ListSkeleton count={8} rowClassName="h-12" />
        </div>
      </div>

      {/* Template approvals section */}
      <div className="space-y-2">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <div className="overflow-x-auto rounded-md border">
          <div className="p-3">
            <Skeleton className="mb-1 h-8 w-full" />
          </div>
          <ListSkeleton count={4} rowClassName="h-10" />
        </div>
      </div>
    </div>
  );
}
