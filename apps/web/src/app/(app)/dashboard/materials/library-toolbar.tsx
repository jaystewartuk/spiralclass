import Link from "next/link";
import { ALL_LEVELS } from "@spiralclass/shared";
import { ChevronLeft, X } from "lucide-react";
import type { LevelRow } from "@/lib/levels";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import {
  materialsClearFiltersHref,
  materialsHref,
  materialsHubHref,
  type MaterialsUrlOverride,
  type MaterialsUrlState,
} from "@/lib/library/materials-href";
import { getT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { MaterialsSort } from "./materials-sort";

// Everything between the search box and the list: where the teacher is, which
// shelf she is on, and how the shelf is narrowed.
//
// THE ONE STRUCTURAL CHANGE. The level row used to be the third of four
// identical chip rows, which made it look like a filter. It is not one — the
// page's own comment says so: it moves the teacher sideways between shelves,
// its "All" points at the ALL_LEVELS sentinel rather than dropping the param,
// and clicking it changes what she is browsing rather than narrowing it. So it
// now sits with the breadcrumb, above the filter panel, and only the three
// axes that genuinely narrow a shelf — category, type, visibility — live
// inside it. That also makes "clear filters" a coherent action: it can empty
// the panel without teleporting her off the shelf.
//
// Each row is a real `role="group"` labelled by its caption, so a screen reader
// announces "Type: All, Written, File, Link" rather than eleven loose links,
// and the selected chip carries `aria-current` rather than being distinguished
// by fill alone.

function Chip({
  href,
  selected,
  children,
}: {
  href: string;
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      // A link, not a button: these are navigations, and `aria-current` is the
      // attribute for "this is the one you are on". `aria-pressed` would claim
      // a toggle that survives the click, which is not what happens here.
      aria-current={selected ? "true" : undefined}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
        selected
          ? "border-transparent bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function ChipRow({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={id}>
      <span id={id} className="w-20 shrink-0 text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

export async function LibraryToolbar({
  urlState,
  levels,
  focusGroups,
  activeLevel,
  activeCategory,
  activeType,
  activeVisibility,
  activeFilterCount,
  visibilityLabel,
  archivedCount,
  total,
  showFilters,
}: {
  urlState: MaterialsUrlState;
  levels: LevelRow[];
  focusGroups: FocusGroup[];
  /** The level id being browsed, or null for the flat all-levels list. */
  activeLevel: string | null;
  activeCategory: string | null;
  activeType: string | null;
  activeVisibility: string | null;
  /** How many of the three narrowing axes (plus the search) are set. */
  activeFilterCount: number;
  visibilityLabel: (v: string) => string;
  archivedCount: number;
  total: number;
  /**
   * False for a library with nothing on either shelf. The filter panel is
   * meaningless there — but the shelf navigation above it is NOT, and gating
   * the whole component on it once left a teacher who opened a level from an
   * empty library with no way back to the hub but the browser's own Back.
   */
  showFilters: boolean;
}) {
  const t = await getT();
  const href = (over: MaterialsUrlOverride) => materialsHref(urlState, over);
  const currentLevel = activeLevel ? levels.find((l) => l.id === activeLevel) : null;

  return (
    <div className="space-y-3">
      {/* Where she is, and the sideways move out of it. Only rendered when a
          hub exists to go back to — a teacher with every level archived has no
          picker, and this would be a link to nowhere. */}
      {levels.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* A plain link, not a <nav>: one back link is not a landmark, and a
              second navigation landmark next to the app's own is noise for
              anyone navigating by landmark. */}
          <Link
            href={materialsHubHref()}
            className="-ml-1 inline-flex items-center gap-1 rounded-sm py-1 pl-1 pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" aria-hidden />
            {t("web.materials.backToLevels")}
          </Link>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t("web.materials.filterLevel")}
          >
            <Chip href={href({ level: ALL_LEVELS })} selected={!currentLevel}>
              {t("web.materials.allLevels")}
            </Chip>
            {levels.map((l) => (
              <Chip key={l.id} href={href({ level: l.id })} selected={currentLevel?.id === l.id}>
                {l.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {showFilters && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div
              className="flex items-center gap-1 rounded-full border bg-background p-0.5"
              role="group"
              // "Shelf", not "Filters": these two are different sets of rows,
              // the way the level row is a different set of rows. The three
              // groups below are the filters.
              aria-label={t("web.materials.shelfLabel")}
            >
              {(["active", "archived"] as const).map((v) => (
                <Link
                  key={v}
                  href={href({ view: v })}
                  aria-current={urlState.view === v ? "page" : undefined}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
                    urlState.view === v
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {v === "active" ? t("web.materials.viewActive") : t("web.materials.archived")}
                  {v === "archived" && archivedCount > 0
                    ? ` (${archivedCount.toLocaleString()})`
                    : ""}
                </Link>
              ))}
            </div>

            {/* The list size, at the top where the decision to narrow is made.
              It was only ever printed by the pagination control at the very
              bottom, below a screenful of rows. `aria-live` because a search
              keystroke re-renders this without moving focus — the count is the
              only signal a screen-reader user gets that the list changed. */}
            <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
              {t("web.materials.resultCount", { count: total })}
            </p>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-xs font-semibold text-muted-foreground sm:inline">
                {t("web.materials.sortLabel")}
              </span>
              <MaterialsSort />
            </div>
          </div>

          {focusGroups.length > 0 && (
            <ChipRow id="materials-filter-category" label={t("web.materials.filterCategory")}>
              <Chip href={href({ category: null })} selected={activeCategory === null}>
                {t("web.materials.filterAll")}
              </Chip>
              {focusGroups.map((g) => (
                <Chip
                  key={g.categoryId}
                  href={href({ category: g.categoryId })}
                  selected={activeCategory === g.categoryId}
                >
                  {g.categoryLabel}
                </Chip>
              ))}
            </ChipRow>
          )}

          <ChipRow id="materials-filter-type" label={t("web.materials.filterType")}>
            <Chip href={href({ type: null })} selected={activeType === null}>
              {t("web.materials.filterAll")}
            </Chip>
            {(["content", "file", "link"] as const).map((k) => (
              <Chip key={k} href={href({ type: k })} selected={activeType === k}>
                {t(`materials.contentType.${k === "content" ? "write" : k}`)}
              </Chip>
            ))}
          </ChipRow>

          <ChipRow id="materials-filter-visibility" label={t("web.materials.filterVisibility")}>
            <Chip href={href({ visibility: null })} selected={activeVisibility === null}>
              {t("web.materials.filterAll")}
            </Chip>
            {(["at_or_below", "exact", "all"] as const).map((v) => (
              <Chip key={v} href={href({ visibility: v })} selected={activeVisibility === v}>
                {visibilityLabel(v)}
              </Chip>
            ))}
          </ChipRow>

          {/* One click back to the whole shelf. Absent when there is nothing to
            clear, so it never reads as an action with no effect — and it keeps
            `level`/`view`, because widening a shelf is not leaving it. */}
          {activeFilterCount > 0 && (
            <div className="flex justify-end">
              <Link
                href={materialsClearFiltersHref(urlState)}
                className="inline-flex items-center gap-1 rounded-sm px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden />
                {t("web.materials.clearFilters")}
                <span className="text-muted-foreground/70">
                  ({t("web.materials.activeFilterCount", { count: activeFilterCount })})
                </span>
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
