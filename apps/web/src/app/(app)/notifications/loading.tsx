"use client";

import { useT } from "@/components/locale-provider";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The inbox, while it is being built.
 *
 * This page needs a skeleton more than most screens do: it is
 * `force-dynamic`, and every row is rendered through the dispatcher's variable
 * builder — several templates still issue their own booking lookup, which is
 * why the read-model caps its render fan-out at five (see
 * INBOX_RENDER_CONCURRENCY). A page of rows is several round trips deep even
 * when nothing is wrong, and without this the teacher got a blank frame for
 * all of them.
 *
 * The shape mirrors the real layout — header, the two view links, a day
 * heading, then rows with a mark, two lines and a clock. A skeleton whose
 * shape disagrees with what arrives makes the page appear to jump as it
 * loads, which is worse than no skeleton at all.
 *
 * A Client Component so the waiting state can be ANNOUNCED in the reader's own
 * language: individual `Skeleton`s are `aria-hidden`, so a purely visual
 * placeholder leaves a screen-reader user with an empty page and no signal
 * that anything is coming. Same mechanism `ListSkeleton` uses for the same
 * reason.
 */
export default function NotificationsLoading() {
  const t = useT();

  return (
    <PageShell width="reading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-24" />
        </div>
      </div>

      <Skeleton className="h-10 w-40" />

      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="overflow-hidden rounded-lg border"
      >
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-9 w-full rounded-none" />
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3 lg:gap-4 lg:px-5">
              <Skeleton className="mt-0.5 size-9 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  {/* Alternating widths, so the column reads as copy of
                      differing lengths rather than as a placeholder grid. */}
                  <Skeleton className={i % 2 === 0 ? "h-4 w-48" : "h-4 w-36"} />
                  <Skeleton className="h-3 w-12 shrink-0" />
                </div>
                <Skeleton className={i % 3 === 0 ? "h-3 w-full" : "h-3 w-3/4"} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <Skeleton className="h-4 w-64" />
    </PageShell>
  );
}
