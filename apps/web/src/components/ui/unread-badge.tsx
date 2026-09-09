import { cn } from "@/lib/utils";

/**
 * An unread count, as a pill.
 *
 * One shape wherever it appears — beside the bell in the app bar, on the
 * notifications row in the drawer, and against a conversation in the inbox —
 * because a count that changes size between two places reads as two different
 * counts. It lived as a private function inside app-nav.tsx until the inbox
 * needed the same pill and started to redraw it.
 *
 * The pill itself is `aria-hidden`: a bare "3" announced on its own does not
 * say three of what. Callers that are not already inside a labelled control
 * pass `srLabel` with the whole sentence.
 */
export function UnreadBadge({
  count,
  max = 9,
  srLabel,
  className,
}: {
  count: number;
  /** Counts past this render as "N+". The bell has room for one digit; a list
   * row has room for two. */
  max?: number;
  srLabel?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold leading-none text-primary-foreground",
          className,
        )}
      >
        {count > max ? `${max}+` : count}
      </span>
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </>
  );
}
