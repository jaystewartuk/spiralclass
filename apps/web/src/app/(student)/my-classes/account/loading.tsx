import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";

// Mirrors the real page's shape — title, identity block, jump nav, then the
// first two sections — so the layout doesn't jump when the data lands. The old
// version drew one generic form card, which is not what arrives.
export default function CuentaLoading() {
  return (
    <PageShell width="reading">
      <div className="space-y-1">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Identity: avatar beside name and email. */}
      <div className="space-y-4 rounded-lg border p-5 lg:p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-20 w-20 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-52" />
          </div>
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Jump nav. */}
      <div className="flex gap-2 py-2">
        {["w-16", "w-20", "w-28", "w-24", "w-20", "w-24"].map((width, index) => (
          <Skeleton key={index} className={`h-8 ${width}`} />
        ))}
      </div>

      {[0, 1].map((section) => (
        <div key={section} className="space-y-3">
          <Skeleton className="h-5 w-36" />
          <div className="space-y-4 rounded-lg border p-5 lg:p-6">
            {Array.from({ length: 3 }).map((_, field) => (
              <div key={field} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full" />
              </div>
            ))}
            <Skeleton className="h-11 w-32" />
          </div>
        </div>
      ))}
    </PageShell>
  );
}
