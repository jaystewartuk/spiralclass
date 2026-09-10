import Link from "next/link";
import { ChevronRight, Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { initialsFrom } from "@/lib/initials";
import { bookHref, ROSTER_SEARCH_THRESHOLD, type RosterEntry } from "@/lib/booking/teacher-book";
import type { TFunction } from "@/lib/i18n-translate";

/**
 * Step one: whose class is this?
 *
 * The screen this replaces listed every active student as name-over-email and
 * left it there. Two things were wrong with that, and both cost the teacher a
 * dead end rather than a keystroke:
 *
 *  1. IT SHOWED THE WRONG FACT. An email address does not decide anything on
 *     a booking screen. Whether the student has a package with classes left
 *     decides everything — she is the only kind of student this flow can
 *     finish for — and it was the one thing the list did not say. Picking a
 *     student without one walked into "no bookable package" on the next
 *     screen, having spent a page load to learn something the list already
 *     knew.
 *  2. IT DID NOT SCALE. A roster is a scroll at twenty names and unusable at
 *     eighty, and the only way through it was the browser's own find.
 *
 * So: bookable students first, each row carrying the count, students without a
 * package still listed (she may want to sell one) but visibly set apart and
 * pointed at their own page rather than at a dead end. Search appears once the
 * list is long enough to need it.
 */
export function StudentPicker({
  entries,
  query,
  totalCount,
  date,
  t,
}: {
  /** Already filtered and ordered by the page. */
  entries: RosterEntry[];
  query: string;
  /** The roster size BEFORE the search, which is what decides whether to offer one. */
  totalCount: number;
  /** A day carried in from the calendar, preserved across the picker. */
  date?: string;
  t: TFunction;
}) {
  if (totalCount === 0) {
    return (
      <EmptyState
        icon={Users}
        title={t("web.dashboard.classes.noActiveStudents")}
        description={t("web.dashboard.classes.book.rosterEmptyBody")}
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/students">{t("web.dashboard.classes.book.goToStudents")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {totalCount >= ROSTER_SEARCH_THRESHOLD && (
        // A plain GET form with a real submit, not a debounced auto-submit:
        // this navigates the whole page, and firing that mid-word takes the
        // caret out of the field she is still typing in. Same call the class
        // list's toolbar makes, for the same reason.
        <form method="get" className="flex items-center gap-2">
          {date && <input type="hidden" name="date" value={date} />}
          <div className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="search"
              name="q"
              defaultValue={query}
              aria-label={t("web.dashboard.classes.book.searchLabel")}
              placeholder={t("web.dashboard.classes.book.searchPlaceholder")}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            {t("web.dashboard.classes.list.search.submit")}
          </Button>
          {query && (
            <Button asChild variant="ghost">
              <Link href={bookHref({ date })}>{t("web.dashboard.classes.list.search.clear")}</Link>
            </Button>
          )}
        </form>
      )}

      {entries.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("web.dashboard.classes.book.searchEmptyTitle", { query })}
          description={t("web.dashboard.classes.book.searchEmptyBody")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={bookHref({ date })}>{t("web.dashboard.classes.list.search.clear")}</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {entries.map((entry) => (
                <li key={entry.studentId}>
                  <StudentRow entry={entry} date={date} t={t} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StudentRow({ entry, date, t }: { entry: RosterEntry; date?: string; t: TFunction }) {
  const bookable = entry.classesAvailable > 0;
  // A student with nothing to book against goes to her own page, where the
  // package gets sold — not one screen deeper into a flow that cannot finish.
  const href = bookable
    ? bookHref({ studentId: entry.studentId, date })
    : `/dashboard/students/${entry.studentId}`;

  return (
    <Link
      href={href}
      className="min-h-target hover:bg-muted/40 focus-visible:ring-ring flex items-center gap-3 px-4 py-3 transition-colors focus-visible:ring-3 focus-visible:outline-none focus-visible:ring-inset lg:px-6"
    >
      {/* Decorative: the name is right beside it, and a screen reader
          announcing "MR" before "Marcela Ruiz" is the same word twice. */}
      <span
        aria-hidden
        className="bg-secondary text-secondary-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold select-none"
      >
        {initialsFrom(entry.name, entry.email)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{entry.name}</span>
        <span className="text-muted-foreground block truncate text-sm">
          {entry.email ?? t("web.dashboard.classes.noEmail")}
        </span>
      </span>

      {/* The count, not the email, is what decides the pick — so it is the
          thing at the end of the row where the eye lands. Never a bare number:
          D-140 keeps a word in every state rather than leaving colour to carry
          it alone. */}
      {bookable ? (
        <Badge variant="success" className="shrink-0">
          {t("web.dashboard.classes.book.available", { count: entry.classesAvailable })}
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground shrink-0">
          {t("web.dashboard.classes.book.noPackage")}
        </Badge>
      )}

      <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
    </Link>
  );
}
