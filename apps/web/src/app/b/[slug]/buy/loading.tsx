import { Skeleton } from "@/components/ui/skeleton";

// The streamed fallback for /b/[slug]/buy. It has to mirror the page's real
// SHAPE, not just look busy: this is a route-level loading UI, so Next wraps
// the page in a Suspense boundary, streams this first, and swaps in the real
// content with its inline `$RS` reveal.
//
// It did not mirror it. D-144 rewrote the page into one narrow column
// (`mx-auto max-w-lg`, summary card then form card), and this skeleton was left
// on the old two-column container (`lg:max-w-4xl`) with a list of package rows
// that no longer exists — so every load painted the previous design for a beat
// and then jumped. Production also logs a React #418 hydration mismatch and a
// pair of `$RS` "Cannot read properties of null (reading 'parentNode')" on this
// route and no other (Sentry AGENDAPROFE-34), which is the shape a fallback and
// its content disagreeing about structure produces.
//
// Keep this in step with purchase-flow.tsx. A skeleton that describes a layout
// the page abandoned is worse than no skeleton: it promises the wrong thing and
// then takes it away.
export default function PublicComprarLoading() {
  return (
    <main className="container py-8 lg:py-12">
      <div className="mx-auto max-w-lg space-y-6">
        {/* Back link */}
        <Skeleton className="h-4 w-48" />

        <div className="space-y-4">
          {/* 1 — who you're buying from, and the chosen package. */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-12 shrink-0 rounded-full" />
              <Skeleton className="h-7 w-56" />
            </div>
            <div className="flex items-start justify-between gap-3 border-t pt-4">
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-6 w-24" />
            </div>
          </div>

          {/* 2 — the pay form: two fields and the button. */}
          <div className="space-y-3 rounded-lg border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}
