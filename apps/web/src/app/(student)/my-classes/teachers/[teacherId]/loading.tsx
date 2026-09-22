import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

// Shaped like the real page rather than a generic spinner, so the layout does
// not jump when the data lands — the profile is three stacked cards behind an
// avatar, and that is what this draws.
export default function StudentTeacherProfileLoading() {
  return (
    <PageShell width="reading">
      <Skeleton className="h-5 w-32" />

      <div className="space-y-5 rounded-lg border p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-20 w-20 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-6 w-32 rounded-full" />
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
        <div className="space-y-3 rounded-md border p-4">
          <Skeleton className="h-4 w-24" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-11 w-full sm:flex-1" />
          <Skeleton className="h-11 w-full sm:flex-1" />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>

      <div className="space-y-3 rounded-lg border p-6">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </PageShell>
  );
}
