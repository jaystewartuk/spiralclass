import { cn } from "@/lib/utils";

// What one day looks like inside the month grid. Styling classes and the
// status label are pre-resolved by the (server) calendar, so this stays a pure
// string renderer with no access to the locale-aware `statusLabel`.
export type DayCellEvent = {
  id: string;
  timeLabel: string;
  title: string;
  statusLabel: string;
  /** Phone-width density marker. */
  dotClass: string;
  /** Labelled pill from `sm` up. */
  chipClass: string;
};

const MAX_CHIPS = 2;
const MAX_DOTS = 4;

/**
 * One day in the month grid.
 *
 * THIS USED TO BE A CLIENT COMPONENT, wrapping the whole cell in a Radix
 * tooltip that listed the day's classes in full on hover. Three things were
 * wrong with that, and they compounded:
 *
 *   * The trigger was a `<div>` passed as `asChild`, nested inside the cell's
 *     own `<Link>`. A div takes no focus, so the preview was unreachable by
 *     keyboard — and on a touch device there is no hover at all, so tapping
 *     the cell navigated instead of revealing anything. The preview existed
 *     for pointer users only, which is the half of the audience least likely
 *     to need it.
 *   * It duplicated the agenda panel directly beneath the grid, which already
 *     lists the selected day's classes in full, at every input modality.
 *   * It made all 35–42 cells client components to render text.
 *
 * So the preview is gone and the whole month view is now server-rendered with
 * no JavaScript. What replaced it is cheaper and works everywhere: the cell's
 * accessible name states the date and the class count, each chip carries a
 * `title` with its untruncated text, and reading a day in full is one click on
 * the cell rather than a hover that only some people can perform.
 */
export function DayCell({
  dayNum,
  isToday,
  inCurrentMonth,
  moreWord,
  events,
}: {
  dayNum: string;
  isToday: boolean;
  inCurrentMonth: boolean;
  /** "more" / "más" — the only locale string this component needs. */
  moreWord: string;
  events: DayCellEvent[];
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <span
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center self-start rounded-full text-sm tabular-nums",
          isToday && "bg-primary text-primary-foreground font-semibold",
          !isToday && inCurrentMonth && "text-foreground font-medium",
          // Ink, not a grey fill. A spill-over day used to get `bg-muted/30`,
          // which on the dark theme is LIGHTER than the page and so read as
          // raised — an inverted elevation ladder on the one row that is
          // supposed to recede.
          !isToday && !inCurrentMonth && "text-subtle",
        )}
      >
        {dayNum}
      </span>

      {/* Wide enough to spell them out. Gated on width, not device tier: a
          7-column grid leaves ~37px of content box on a 375px phone, which
          cannot render `09:30`, but every tablet has room. */}
      <div className="hidden flex-1 flex-col gap-1 sm:flex">
        {events.slice(0, MAX_CHIPS).map((e) => (
          <span
            key={e.id}
            // `title` rather than a tooltip: a long student name truncates in a
            // cell this narrow no matter what, and this is the one preview that
            // needs no JavaScript and no hover-only affordance to be honest.
            title={`${e.timeLabel} · ${e.title} · ${e.statusLabel}`}
            className={cn(
              "flex items-baseline gap-1.5 truncate rounded px-1.5 py-0.5 text-sm leading-snug",
              e.chipClass,
            )}
          >
            <span className="shrink-0 font-semibold tabular-nums">{e.timeLabel}</span>
            <span className="truncate">{e.title}</span>
          </span>
        ))}
        {events.length > MAX_CHIPS && (
          <span className="text-muted-foreground px-1.5 text-sm">
            +{events.length - MAX_CHIPS} {moreWord}
          </span>
        )}
      </div>

      {/* Too narrow for a chip: density dots. They are decoration — the cell's
          own aria-label carries the count — so they are hidden from assistive
          tech rather than each announcing a time nobody asked for. */}
      {events.length > 0 && (
        <div aria-hidden className="flex flex-wrap gap-1 sm:hidden">
          {events.slice(0, MAX_DOTS).map((e) => (
            <span key={e.id} className={cn("h-1.5 w-1.5 rounded-full", e.dotClass)} />
          ))}
        </div>
      )}
    </div>
  );
}
