import { ALL_LEVELS } from "@spiralclass/shared";
import type { LibrarySort } from "@/lib/library/library-queries";

// URL building for the Materials page's level-first navigation. Extracted out
// of the page component (it was four near-identical inline closures) so the one
// rule that actually matters here is unit-testable: which state each link
// carries forward, and — since the redesign — whether a link lands on the level
// hub or stays in the list.
//
// The trap this exists to prevent: "All" used to mean "drop ?level=", which now
// means "go back to the hub". Every in-list link must therefore carry an
// explicit level value (a level id or the ALL_LEVELS sentinel), or clicking a
// type filter inside the all-levels list would eject the teacher to the level
// picker and silently drop her filters.

export type MaterialsUrlState = {
  // A level id, ALL_LEVELS, or null (= the hub). Already validated by the page
  // against the teacher's own levels.
  level: string | null;
  category: string | null;
  type: string | null;
  visibility: string | null;
  q: string;
  sort: LibrarySort;
  view: "active" | "archived";
};

// Each axis is optional; passing it (even as null) overrides, omitting it
// inherits from the current state. `null` clears that axis.
export type MaterialsUrlOverride = Partial<
  Pick<MaterialsUrlState, "level" | "category" | "type" | "visibility" | "q" | "sort" | "view">
>;

export const MATERIALS_PATH = "/dashboard/materials";

function pick<T>(over: T | undefined, current: T): T {
  return over !== undefined ? over : current;
}

// Builds a Materials URL from the current state plus an override. Always drops
// `?page=` — every axis this touches invalidates the current page window, so a
// changed filter restarts at page 1. Defaults (sort=recent, view=active) are
// omitted so the common URL stays clean.
export function materialsHref(state: MaterialsUrlState, over: MaterialsUrlOverride = {}): string {
  const p = new URLSearchParams();
  const level = pick(over.level, state.level);
  const category = pick(over.category, state.category);
  const type = pick(over.type, state.type);
  const visibility = pick(over.visibility, state.visibility);
  const q = pick(over.q, state.q);
  const sort = pick(over.sort, state.sort);
  const view = pick(over.view, state.view);

  if (level) p.set("level", level);
  if (category) p.set("category", category);
  if (type) p.set("type", type);
  if (visibility) p.set("visibility", visibility);
  if (q) p.set("q", q);
  if (sort !== "recent") p.set("sort", sort);
  if (view !== "active") p.set("view", view);

  const qs = p.toString();
  return qs ? `${MATERIALS_PATH}?${qs}` : MATERIALS_PATH;
}

// The "back to the level picker" link — deliberately drops every filter, not
// just the level. Going back to the hub is a fresh start; carrying a stale
// type/visibility chip into the next shelf the teacher opens would silently
// hide materials she'd just navigated to see.
export function materialsHubHref(): string {
  return MATERIALS_PATH;
}

// Opens one level's shelf from the hub. Same reasoning as above: a shelf opens
// unfiltered, showing everything filed at that level.
export function materialsLevelHref(levelId: string): string {
  return `${MATERIALS_PATH}?level=${encodeURIComponent(levelId)}`;
}

// The "Todos los materiales" escape hatch — the flat, all-levels list.
export function materialsAllLevelsHref(): string {
  return `${MATERIALS_PATH}?level=${ALL_LEVELS}`;
}

// Clears the NARROWING filters — category, type, visibility and the search —
// while keeping the shelf the teacher is standing in (`level`) and the shelf
// she is standing on (`view`). Those two are navigation, not filters: clearing
// them would teleport her to a different list rather than widening the one she
// is looking at, and clearing `level` specifically would drop her back on the
// hub (see the note at the top of this file).
export function materialsClearFiltersHref(state: MaterialsUrlState): string {
  return materialsHref(state, { category: null, type: null, visibility: null, q: "" });
}

// The params the <Pagination> control must re-attach to each page link. Mirrors
// materialsHref's omit-the-defaults rule; `page` itself is added by the control.
export function materialsPageParams(state: MaterialsUrlState): Record<string, string | undefined> {
  return {
    level: state.level ?? undefined,
    category: state.category ?? undefined,
    type: state.type ?? undefined,
    visibility: state.visibility ?? undefined,
    q: state.q || undefined,
    sort: state.sort !== "recent" ? state.sort : undefined,
    view: state.view !== "active" ? state.view : undefined,
  };
}
