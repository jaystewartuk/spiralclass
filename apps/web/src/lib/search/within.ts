import { ALL_LEVELS } from "@spiralclass/shared";
import type { StringKey } from "@/lib/i18n-translate";
import { classesHref } from "@/lib/classes-list";
import { leadsHref } from "@/lib/leads/list";
import { materialsHref } from "@/lib/library/materials-href";
import { studentsHref } from "@/lib/students-list";

// "Search classes for 'ana'" — the rows at the foot of every non-empty search.
//
// The index the dialog searches is bounded (a window of classes around today,
// the most recent leads and materials — lib/search/teacher-records.ts), so a
// query can be about something real that is not in it: a class from last
// spring, the student's materials. These rows hand the query to the page that
// searches everything of its kind, through that page's own URL builder, so the
// search box never ends in a dead end.

export type SearchAudience = "teacher" | "student";

/** The teacher's whole library, searched for `q` across every level. */
export function materialsSearchHref(q: string): string {
  return materialsHref({
    level: ALL_LEVELS,
    category: null,
    type: null,
    visibility: null,
    q,
    sort: "recent",
    view: "active",
  });
}

export type SearchWithinLink = { id: string; label: StringKey; href: string };

export function searchWithinLinks(audience: SearchAudience, query: string): SearchWithinLink[] {
  const q = query.trim();
  if (!q) return [];
  if (audience === "student") {
    return [
      {
        id: "materials",
        label: "web.search.within.materials",
        href: `/my-classes/materials?${new URLSearchParams({ q })}`,
      },
    ];
  }
  return [
    {
      id: "students",
      label: "web.search.within.students",
      href: studentsHref("active", { search: q }),
    },
    { id: "classes", label: "web.search.within.classes", href: classesHref("past", q) },
    {
      id: "materials",
      label: "web.search.within.materials",
      href: materialsSearchHref(q),
    },
    { id: "leads", label: "web.search.within.leads", href: leadsHref("open", q) },
  ];
}
