import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

// The placeholder for the LEVEL HUB, not for the list.
//
// `loading.tsx` cannot read searchParams, so it has to pick one shape — and it
// was drawing the filter toolbar plus six list rows, which is the shape of
// `?level=…`. Landing on /dashboard/materials with no params renders the hub
// (see page.tsx), so the most common first paint in the app was a skeleton of
// a screen that was never about to appear, and it visibly reshuffled the
// moment the RSC arrived.
//
// A shelf still swaps in from a warm client cache — a navigation from the hub
// keeps the page's rendered output rather than falling back here — so the case
// this gets right is the one it is actually shown for: a cold load of
// /dashboard/materials.
export default function MaterialsLoading() {
  return (
    <PageShell width="wide">
      {/* Header: title + description, with the two header actions on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-28 lg:h-9" />
          <Skeleton className="h-11 w-36 lg:h-10" />
        </div>
      </div>

      {/* Search */}
      <Skeleton className="h-11 w-full lg:h-10" />

      {/* "Choose a level" + its one-line explanation */}
      <div className="space-y-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* The level grid, at the hub's own breakpoints so nothing jumps
          columns when the real cards land. Six, because every teacher is
          seeded with the six CEFR levels. */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        role="status"
        aria-busy="true"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>

      {/* The dashed "all materials" escape hatch below the grid. */}
      <Skeleton className="h-20 w-full" />
    </PageShell>
  );
}
