import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import { LEGEND_STATUSES, styleFor } from "./status-style";

/**
 * What the colours in the grid mean.
 *
 * It takes the CALLER's `statusLabel` rather than reading `booking.status.*`
 * itself. The month view used to do the latter, which is how the key said
 * "Canceled" beside a chip in the very same view that said "Cancelled
 * (student)" — two spellings of one word, from two catalogs, three inches
 * apart. There is now one source for a status's name per surface, and the key
 * cannot disagree with the thing it is a key to.
 */
export function CalendarLegend({
  statusLabel,
  t,
}: {
  statusLabel: (status: string) => string;
  t: TFunction;
}) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
      <span className="sr-only">{t("web.calendar.legendTitle")}</span>
      {LEGEND_STATUSES.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("h-2 w-2 rounded-full", styleFor(status).dot)} />
          {statusLabel(status)}
        </span>
      ))}
    </div>
  );
}
