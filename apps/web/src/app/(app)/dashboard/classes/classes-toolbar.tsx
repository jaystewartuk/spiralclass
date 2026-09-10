import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CLASSES_SCOPES, classesHref, type ClassesScope } from "@/lib/classes-list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The list's controls: which view, and which student.
 *
 * LINKS, NOT A TAB WIDGET. These look like tabs and they are not: each one is
 * a different server-rendered list at its own URL, so it is navigation.
 * Building it out of Radix `Tabs` would need client JavaScript to do less —
 * no deep link, no back button, no middle-click into a new tab — and would
 * announce a tablist to a screen reader that has no tab panel behind it.
 * `aria-current="page"` is what actually carries the selected state.
 *
 * The search is a plain GET form with a real submit. It deliberately does NOT
 * use the debounced auto-submit the admin filter bars use: that fires a full
 * page navigation mid-word, which takes the caret out of the field the person
 * is still typing in. Enter (or the button) is the whole interaction, it works
 * with JavaScript off, and the result is a URL she can bookmark.
 */
export function ClassesToolbar({
  scope,
  search,
  needsMaterialsCount,
  t,
}: {
  scope: ClassesScope;
  search: string;
  needsMaterialsCount: number;
  t: TFunction;
}) {
  const SCOPE_LABEL: Record<ClassesScope, string> = {
    upcoming: t("web.dashboard.classes.list.scope.upcoming"),
    materials: t("web.dashboard.classes.list.scope.materials"),
    past: t("web.dashboard.classes.list.scope.past"),
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* `overflow-x-auto` rather than wrapping: three short labels fit every
          viewport this ships to, and a scroller keeps them on one line if a
          translation or a raised text size makes them not. */}
      <nav
        aria-label={t("web.dashboard.classes.list.viewsLabel")}
        className="bg-muted -mx-1 flex gap-1 self-start overflow-x-auto rounded-md p-1"
      >
        {CLASSES_SCOPES.map((value) => {
          const active = value === scope;
          return (
            <Link
              key={value}
              href={classesHref(value, search)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-background text-foreground shadow-brand-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SCOPE_LABEL[value]}
              {/* Only on the view whose count is a job to do. A "3" beside
                  "Upcoming" would be a number the list underneath already
                  shows; a "3" beside "Needs materials" is three classes she
                  has not prepared. */}
              {value === "materials" && needsMaterialsCount > 0 && (
                <Badge variant="warning">{needsMaterialsCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <form method="get" className="flex items-center gap-2">
        {/* Carries the current view across a search, so searching from "Past"
            searches the past rather than silently dropping back to upcoming. */}
        {scope !== "upcoming" && <input type="hidden" name="show" value={scope} />}
        <div className="relative min-w-0 flex-1 lg:w-56 lg:flex-none">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={search}
            aria-label={t("web.dashboard.classes.list.search.label")}
            placeholder={t("web.dashboard.classes.list.search.placeholder")}
            className="pl-9"
          />
        </div>
        {/* Default size, not `sm`: `Input` is h-11/h-10 and a `sm` button is
            h-10/h-9, so the control beside the field sat four pixels short of
            it on every viewport. */}
        <Button type="submit" variant="secondary">
          {t("web.dashboard.classes.list.search.submit")}
        </Button>
        {search && (
          <Button asChild variant="ghost">
            <Link href={classesHref(scope)}>{t("web.dashboard.classes.list.search.clear")}</Link>
          </Button>
        )}
      </form>
    </div>
  );
}
