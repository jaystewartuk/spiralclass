import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";

export default function MisClasesLoading() {
  return (
    <PageShell width="default">
      {/* Greeting */}
      <div className="space-y-1">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-32" />
      </div>

      {/* Mis paquetes card */}
      <div className="space-y-4 rounded-lg border p-6">
        <div className="space-y-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2 opacity-70">
            <div className="space-y-1">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Próximas clases card */}
      <div className="space-y-3 rounded-lg border p-6">
        <Skeleton className="h-5 w-32" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between rounded-md px-2 py-1">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
