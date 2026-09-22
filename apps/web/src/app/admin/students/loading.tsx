import { Skeleton } from "@/components/ui/skeleton";
import { ListSkeleton } from "@/components/ui/skeleton";

export default function AdminStudentsLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-20" />
      </div>

      {/* Student list */}
      <ListSkeleton count={8} />
    </div>
  );
}
