import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";

export default function ReservarLoading() {
  return (
    <PageShell width="reading">
      {/* Back link */}
      <Skeleton className="h-4 w-36" />

      {/* Booking card */}
      <div className="space-y-4 rounded-lg border p-6">
        <div className="space-y-1">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>

        {/* Date nav */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>

        {/* Slots grid */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
