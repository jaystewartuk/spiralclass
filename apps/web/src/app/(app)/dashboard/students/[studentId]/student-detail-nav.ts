import type { StringKey } from "@/lib/i18n-translate";
import {
  DEFAULT_MATERIALS_FILTER,
  DEFAULT_MATERIALS_GROUP_BY,
  type StudentMaterialsFilter,
  type StudentMaterialsGroupBy,
} from "@/lib/materials/student-materials";

/**
 * The five views of one student, and the URL that addresses each.
 *
 * WHY VIEWS AT ALL. This screen used to be eleven cards in one column, every
 * one of them expanded, with an editing form open inside most of them: the
 * agreed-price grid, the contact form, the profile textareas and a full
 * edit-package form per package all rendered whether or not anyone was
 * editing anything. It answered no question quickly because it answered all
 * of them at once, and the sticky ten-pill scroll-spy bar it grew was the
 * admission — a page that needs its own table of contents is a page that
 * should have been split. Splitting it is also the only change that helps the
 * reader D-140 is written for: less on the screen, and what is there is about
 * one thing.
 *
 * The order is the order a teacher needs them in: what is happening with this
 * student, what she has bought, what to teach her, what has been sent, and
 * finally the details that change once a year.
 *
 * WHY LINKS AND `?tab=`, not a client tab widget. The tab survives a refresh,
 * a bookmark and the back button; every panel stays a Server Component with
 * no hydration; and the page can fetch only the tab it is about to render
 * rather than all eleven sections' worth on every load. The cost is a
 * navigation per switch, which Next prefetches.
 */
export const STUDENT_TABS = ["overview", "packages", "learning", "materials", "settings"] as const;

export type StudentTab = (typeof STUDENT_TABS)[number];

export const DEFAULT_STUDENT_TAB: StudentTab = "overview";

/** The catalog key naming each tab, so the nav and any deep link agree. */
export const STUDENT_TAB_LABEL_KEY: Record<StudentTab, StringKey> = {
  overview: "web.dashboard.students.tab.overview",
  packages: "web.dashboard.students.section.packages",
  learning: "web.dashboard.students.tab.learning",
  materials: "web.dashboard.students.tab.materials",
  settings: "web.dashboard.students.tab.settings",
};

/**
 * A `?tab=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing — a hand-edited or stale link should still
 * show the teacher her student, the same rule `resolveClassesScope` follows.
 */
export function resolveStudentTab(raw: string | string[] | undefined): StudentTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (STUDENT_TABS as readonly string[]).includes(value ?? "")
    ? (value as StudentTab)
    : DEFAULT_STUDENT_TAB;
}

/**
 * The canonical URL for one view of one student, so no call site builds one by
 * hand.
 *
 * The materials filters ride along because they belong to a tab that is not
 * always the current one: the Overview's "see everything sent" link has to
 * name both the tab and the filter it wants. Defaults are omitted from the
 * query so the plain student URL stays clean and shareable.
 */
export function studentDetailHref(
  studentId: string,
  tab: StudentTab = DEFAULT_STUDENT_TAB,
  materials?: { filter?: StudentMaterialsFilter; groupBy?: StudentMaterialsGroupBy },
): string {
  const params = new URLSearchParams();
  if (tab !== DEFAULT_STUDENT_TAB) params.set("tab", tab);
  if (materials?.filter && materials.filter !== DEFAULT_MATERIALS_FILTER) {
    params.set("mf", materials.filter);
  }
  if (materials?.groupBy && materials.groupBy !== DEFAULT_MATERIALS_GROUP_BY) {
    params.set("mg", materials.groupBy);
  }
  const query = params.toString();
  return query ? `/dashboard/students/${studentId}?${query}` : `/dashboard/students/${studentId}`;
}
