import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "@/components/ui/skeleton";

export default function AdminPackagesLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-56" />
      </div>

      {/* Filter bar */}
      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="space-y-1 lg:col-span-2">
            <Skeleton className="h-3 w-52" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="flex items-end gap-2 lg:col-span-4">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
          </div>
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
  );
}
