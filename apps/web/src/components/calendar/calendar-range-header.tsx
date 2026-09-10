import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The bar above every calendar grid: what range is on screen, how much is in
 * it, and the three controls that move it.
 *
 * One component for month, week and day because it was three near-copies that
 * had already drifted — the month used an `h3`-sized `Heading`, the week an
 * `h4`, and the day a bare `<h2 className="text-base">` that turned blue when
 * it happened to be today. Whatever the argument for each in isolation, the
 * result was a heading that changed size when you switched view, which reads
 * as the page reloading into a different design.
 *
 * The count is the part that is new, and it is the cheapest useful thing this
 * screen can say: a teacher opening a calendar wants to know how full the
 * range is before she reads any single cell.
 */
export function CalendarRangeHeader({
  title,
  titleClassName,
  count,
  prev,
  next,
  todayHref,
  t,
}: {
  title: string;
  titleClassName?: string;
  /** Classes in the range on screen. */
  count: number;
  prev: { href: string; label: string };
  next: { href: string; label: string };
  todayHref: string;
  t: TFunction;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={cn("text-h3 min-w-0 truncate font-semibold", titleClassName)}>{title}</h2>
        <span className="text-muted-foreground text-sm tabular-nums">
          {count === 0 ? t("web.calendar.noClasses") : t("web.calendar.classCount", { count })}
        </span>
      </div>
      {/* A segmented cluster rather than three loose links: they are one
          control (move the range), and the 44px targets are the D-140 minimum
          rather than the ~30px the loose links used to be. */}
      <div className="bg-card flex shrink-0 items-center rounded-lg border">
        <NavLink href={prev.href} label={prev.label} className="rounded-l-lg border-r">
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </NavLink>
        <Link
          href={todayHref}
          className="min-h-target hover:bg-muted/60 flex items-center px-4 text-sm font-medium transition-colors focus-visible:z-10"
        >
          {t("web.calendar.today")}
        </Link>
        <NavLink href={next.href} label={next.label} className="rounded-r-lg border-l">
          <ChevronRight aria-hidden className="h-5 w-5" />
        </NavLink>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  className,
  children,
}: {
  href: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(
        "min-h-target text-muted-foreground hover:bg-muted/60 hover:text-foreground flex w-11 items-center justify-center transition-colors focus-visible:z-10",
        className,
      )}
    >
      {children}
    </Link>
  );
}
