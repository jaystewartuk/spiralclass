import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/ui/page-shell";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The roster's shape, before it has any content.
 *
 * It mirrors the real layout — two columns, a toolbar, a card of rows with an
 * avatar and a right-hand figure — because a placeholder that does not is
 * worse than none: the page visibly rearranges itself under the reader at the
 * moment the data lands. This one only fills in.
 */
export default function StudentsLoading() {
  return (
    <PageShell width="wide">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-10 w-full lg:w-80" />
          </div>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3 lg:px-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-48" />
            </div>
            <ul className="divide-border divide-y">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3 lg:px-6">
                  <Skeleton className="size-9 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-56" />
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-4 w-10" />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside>
          <Card>
            <CardContent className="space-y-4 pt-6">
              <Skeleton className="h-5 w-28" />
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-8" />
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}
