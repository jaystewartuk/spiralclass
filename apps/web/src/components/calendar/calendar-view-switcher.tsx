import Link from "next/link";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

const VIEWS = ["month", "week", "day"] as const;
export type CalendarViewName = (typeof VIEWS)[number];

/**
 * Month / week / day.
 *
 * Written twice before (the teacher calendar and the student one), identically
 * both times, at `px-2.5 py-1` — a 31px-tall target on a screen whose own
 * standard is 44 (D-140), and small enough that the "selected" segment read as
 * a slightly different shade of nothing.
 *
 * The selected segment is now stated three ways, because one is never enough:
 * a filled surface (sighted), `aria-current="page"` (assistive tech) and the
 * fact that it is the only segment carrying full-contrast text (low vision,
 * and anyone whose display is not showing the tint faithfully).
 */
export function CalendarViewSwitcher({
  active,
  href,
  t,
}: {
  active: CalendarViewName;
  href: (view: CalendarViewName) => string;
  t: TFunction;
}) {
  return (
    <nav
      aria-label={t("calendar.viewCta")}
      className="flex w-full max-w-xs rounded-lg bg-muted p-1 sm:w-fit sm:max-w-none"
    >
      {VIEWS.map((view) => {
        const isActive = view === active;
        return (
          <Link
            key={view}
            href={href(view)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-h-target flex-1 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors sm:flex-none sm:px-6",
              isActive
                ? "bg-card text-foreground shadow-brand-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view === "month"
              ? t("calendar.viewMonth")
              : view === "week"
                ? t("calendar.viewWeek")
                : t("calendar.viewDay")}
          </Link>
        );
      })}
    </nav>
  );
}
