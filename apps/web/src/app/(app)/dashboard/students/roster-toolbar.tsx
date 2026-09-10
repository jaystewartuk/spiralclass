import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_STUDENT_SCOPE,
  DEFAULT_STUDENT_SORT,
  STUDENT_SCOPES,
  STUDENT_SORTS,
  studentsHref,
  type StudentScope,
  type StudentSort,
} from "@/lib/students-list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The roster's controls: which view, and which student.
 *
 * LINKS, NOT A TAB WIDGET — the same call the class list documents. Each view
 * is a server-rendered list at its own URL, so it is navigation: deep-linkable,
 * back-buttonable, middle-clickable, and working with JavaScript off. A Radix
 * `Tabs` here would need client JavaScript to do strictly less, and would
 * announce a tablist to a screen reader with no tab panel behind it.
 * `aria-current` is what carries the selected state.
 *
 * The search is a plain GET form with a real submit, deliberately NOT the
 * debounced auto-submit the admin filter bars use: that navigates mid-word and
 * takes the caret out of the field the person is still typing in.
 */
export function RosterToolbar({
  scope,
  search,
  sort,
  attentionCount,
  t,
}: {
  scope: StudentScope;
  search: string;
  sort: StudentSort;
  attentionCount: number;
  t: TFunction;
}) {
  const SCOPE_LABEL: Record<StudentScope, string> = {
    active: t("web.dashboard.students.roster.scope.active"),
    attention: t("web.dashboard.students.roster.scope.attention"),
    archived: t("web.dashboard.students.roster.scope.archived"),
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* `overflow-x-auto` rather than wrapping: three labels fit every viewport
          this ships to, and a scroller keeps them on one line if a translation
          or a raised reading scale makes them not. */}
      <nav
        aria-label={t("web.dashboard.students.roster.viewsLabel")}
        className="bg-muted -mx-1 flex gap-1 self-start overflow-x-auto rounded-md p-1"
      >
        {STUDENT_SCOPES.map((value) => {
          const active = value === scope;
          return (
            <Link
              key={value}
              href={studentsHref(value, { search, sort })}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-background text-foreground shadow-brand-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SCOPE_LABEL[value]}
              {/* Only on the view whose count is a job to do. A number beside
                  "Active" would restate what the list underneath already
                  shows; a number beside "Needs attention" is a to-do list. */}
              {value === "attention" && attentionCount > 0 && (
                <Badge variant="warning">{attentionCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <form method="get" className="flex items-center gap-2">
        {/* Carry the current view and order through a search, so searching
            from "Archived" searches the archived rather than silently dropping
            back to the active roster. */}
        {scope !== DEFAULT_STUDENT_SCOPE && <input type="hidden" name="show" value={scope} />}
        {sort !== DEFAULT_STUDENT_SORT && <input type="hidden" name="sort" value={sort} />}
        <div className="relative min-w-0 flex-1 lg:w-64 lg:flex-none">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={search}
            aria-label={t("web.dashboard.students.roster.search.label")}
            placeholder={t("web.dashboard.students.roster.search.placeholder")}
            className="pl-9"
          />
        </div>
        {/* Default size, not `sm`: `Input` is h-11/h-10 and a `sm` button is
            h-10/h-9, so the control beside the field would sit four pixels
            short of it on every viewport. */}
        <Button type="submit" variant="secondary">
          {t("web.dashboard.students.roster.search.submit")}
        </Button>
        {search && (
          <Button asChild variant="ghost">
            <Link href={studentsHref(scope, { sort })}>
              {t("web.dashboard.students.roster.search.clear")}
            </Link>
          </Button>
        )}
      </form>
    </div>
  );
}

/**
 * The strip above the rows: how many there are, and in what order.
 *
 * The count is here rather than in the aside because it is a fact ABOUT THIS
 * LIST — it changes with the search and the view, which the aside's standing
 * figures deliberately do not.
 *
 * Sort is `aria-current="true"`, not `"page"`: re-ordering a list does not
 * make it a different page, and `page` is specified as "the current page
 * within a set of pages".
 */
export function RosterListHeader({
  scope,
  search,
  sort,
  count,
  t,
}: {
  scope: StudentScope;
  search: string;
  sort: StudentSort;
  count: number;
  t: TFunction;
}) {
  const SORT_LABEL: Record<StudentSort, string> = {
    recent: t("web.dashboard.students.roster.sort.recent"),
    name: t("web.dashboard.students.roster.sort.name"),
    balance: t("web.dashboard.students.roster.sort.balance"),
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 lg:px-6">
      <p className="text-muted-foreground text-sm">
        {t("web.dashboard.students.roster.count", { count })}
      </p>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <span className="text-muted-foreground text-sm" id="roster-sort-label">
          {t("web.dashboard.students.roster.sortLabel")}
        </span>
        <nav aria-labelledby="roster-sort-label" className="flex flex-wrap items-center gap-1">
          {STUDENT_SORTS.map((value) => {
            const active = value === sort;
            return (
              <Link
                key={value}
                href={studentsHref(scope, { search, sort: value })}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "rounded-sm px-2 py-1 text-sm transition-colors",
                  active
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {SORT_LABEL[value]}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
