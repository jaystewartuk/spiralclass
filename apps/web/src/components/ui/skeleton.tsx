"use client";

import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-muted animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

/**
 * A vertical stack of skeleton rows for list/table placeholders.
 */
function ListSkeleton({
  count = 5,
  className,
  rowClassName,
}: {
  count?: number;
  className?: string;
  rowClassName?: string;
}) {
  // Was the literal "Cargando…". A screen-reader string, so an English or
  // French reader heard Spanish and nothing visual gave it away — the reason an
  // i18n leak in a 30-importer component survived the rest of the migration.
  const t = useT();
  return (
    <div className={cn("space-y-3", className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cn("h-12 w-full", rowClassName)} />
      ))}
    </div>
  );
}

export { Skeleton, ListSkeleton };
