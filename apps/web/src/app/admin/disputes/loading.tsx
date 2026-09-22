import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "@/components/ui/skeleton";

export default function AdminDisputesLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="mt-2 h-4 w-48" />
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
