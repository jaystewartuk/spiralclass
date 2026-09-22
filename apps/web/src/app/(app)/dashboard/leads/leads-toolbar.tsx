import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LEAD_SCOPES, leadsHref, type LeadScope } from "@/lib/leads/list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The list's controls: which view, and which person.
 *
 * LINKS, NOT A TAB WIDGET — the same reasoning as the class list's toolbar.
 * Each view is a different server-rendered list at its own URL, so it is
 * navigation: a Radix `Tabs` here would need client JavaScript to do less (no
 * deep link, no back button, no middle-click) and would announce a tablist to
 * a screen reader with no tab panel behind it. `aria-current="page"` carries
 * the selected state.
 *
 * Only ONE count is shown, on `Open`, and only when it is above zero. The
 * other two views' counts are facts the list underneath already states; the
 * open count is the one number that is a job to do, and it is the reason this
 * screen is in the nav at all.
 */
export function LeadsToolbar({
  scope,
  search,
  openCount,
  t,
}: {
  scope: LeadScope;
  search: string;
  openCount: number;
  t: TFunction;
}) {
  const SCOPE_LABEL: Record<LeadScope, string> = {
    open: t("web.dashboard.leads.scopeOpen"),
    converted: t("web.dashboard.leads.scopeConverted"),
    archived: t("web.dashboard.leads.scopeArchived"),
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* `overflow-x-auto` rather than wrapping: three short labels fit every
          viewport this ships to, and a scroller keeps them on one line if a
          translation or a raised text size makes them not. */}
      <nav
        aria-label={t("web.dashboard.leads.viewsLabel")}
        className="-mx-1 flex gap-1 self-start overflow-x-auto rounded-md bg-muted p-1"
      >
        {LEAD_SCOPES.map((value) => {
          const active = value === scope;
          return (
            <Link
              key={value}
              href={leadsHref(value, search)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-background text-foreground shadow-brand-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SCOPE_LABEL[value]}
              {value === "open" && openCount > 0 && <Badge>{openCount}</Badge>}
            </Link>
          );
        })}
      </nav>

      <form method="get" className="flex items-center gap-2">
        {/* Carries the current view across a search, so searching from
            "Archived" searches the archive rather than silently dropping back
            to the open list. */}
        {scope !== "open" && <input type="hidden" name="show" value={scope} />}
        <div className="relative min-w-0 flex-1 lg:w-56 lg:flex-none">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={search}
            aria-label={t("web.dashboard.leads.searchLabel")}
            placeholder={t("web.dashboard.leads.searchPlaceholder")}
            className="pl-9"
          />
        </div>
        {/* Default size, not `sm`: `Input` is h-11/h-10 and a `sm` button is
            h-10/h-9, so the control beside the field would sit four pixels
            short of it on every viewport. */}
        <Button type="submit" variant="secondary">
          {t("web.dashboard.leads.searchSubmit")}
        </Button>
        {search && (
          <Button asChild variant="ghost">
            <Link href={leadsHref(scope)}>{t("web.dashboard.leads.searchClear")}</Link>
          </Button>
        )}
      </form>
    </div>
  );
}
