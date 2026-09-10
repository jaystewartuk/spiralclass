"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CallMaterial,
  ClassContentFocusGroup,
  LibraryMaterialAdmin,
  LibraryVisibility,
  MaterialAttachmentKind,
  TeacherLibraryFilterMeta,
  TeacherLibraryLevel,
  TeacherLibraryMaterialsPage,
} from "@spiralclass/shared";
import { useT } from "@/components/locale-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

// Teacher-only "My library" tab inside the in-call Materials sheet
// (call-materials-panel.tsx). It reads two web endpoints —
// `/api/teacher/library/filters` for the chip rows and
// `/api/teacher/library/materials` for the list — both of which sit on the
// same server-side query/filter engine the library screens share
// (lib/library/library-queries.ts).
//
// Those two used to live in a route tree that has since been deleted; a web
// component reaching into it made a dead namespace look load-bearing.
// This component only adds a browsing/picking UI on top; creating, editing or
// archiving a material is intentionally out of scope here — mid-call the
// teacher browses and opens, she doesn't manage her library (that stays on
// /dashboard/materials).
const PAGE_LIMIT = 30;

export function toCallMaterial(m: LibraryMaterialAdmin): CallMaterial {
  return {
    id: m.id,
    label: m.label,
    kind: m.attachmentKind,
    body: m.body ?? null,
    viewUrl: m.viewUrl,
    // Carried through, never re-derived here: the client holds a signed URL,
    // and the filename this is read from lives on the server (library-admin.ts).
    fileKind: m.fileKind,
  };
}

type Filters = {
  category: string | null;
  level: string | null;
  type: MaterialAttachmentKind | null;
  visibility: LibraryVisibility | null;
};

// Pure query-string builder for GET /api/teacher/library/materials —
// pulled out of the component so the filter → query-param mapping (the part
// most likely to silently drift from parseLibraryListParams on the server) is
// unit-testable without rendering anything.
export function buildLibraryQueryParams(
  filters: Filters,
  q: string,
  sort: "recent" | "oldest",
  limit: number,
  cursor: string | null,
): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.category) p.set("category", filters.category);
  if (filters.level) p.set("level", filters.level);
  if (filters.type) p.set("type", filters.type);
  if (filters.visibility) p.set("visibility", filters.visibility);
  if (q.trim()) p.set("q", q.trim());
  if (sort !== "recent") p.set("sort", sort);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  return p;
}

export function CallLibraryBrowser({ onSelect }: { onSelect: (m: CallMaterial) => void }) {
  const t = useT();
  const [meta, setMeta] = useState<{
    levels: TeacherLibraryLevel[];
    focusGroups: ClassContentFocusGroup[];
  } | null>(null);

  const [filters, setFilters] = useState<Filters>({
    category: null,
    level: null,
    type: null,
    visibility: null,
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "oldest">("recent");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [items, setItems] = useState<LibraryMaterialAdmin[]>([]);
  const cursorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const runIdRef = useRef(0);

  // Bootstrap once — levels + focus-tag categories seed the filter chips. A
  // failure here just means the category/level chip rows don't render;
  // search/type/visibility filtering and the list itself don't depend on it.
  useEffect(() => {
    let cancelled = false;
    fetchWithTimeout("/api/teacher/library/filters")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<TeacherLibraryFilterMeta>;
      })
      .then((data) => {
        if (!cancelled) setMeta({ levels: data.levels, focusGroups: data.focusGroups });
      })
      .catch(() => {
        // Silently skip — chips just render without category/level rows.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim();
  const buildQuery = useCallback(
    (cursor: string | null) =>
      buildLibraryQueryParams(filters, q, sort, PAGE_LIMIT, cursor).toString(),
    [filters, q, sort],
  );

  const fetchReset = useCallback(async () => {
    const runId = ++runIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithTimeout(`/api/teacher/library/materials?${buildQuery(null)}`);
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TeacherLibraryMaterialsPage;
      if (runId !== runIdRef.current) return; // a newer filter run superseded this
      setItems(page.items);
      cursorRef.current = page.nextCursor;
    } catch {
      if (runId !== runIdRef.current) return;
      setError(true);
    } finally {
      if (runId === runIdRef.current) setLoading(false);
    }
  }, [buildQuery]);

  // Debounced so typing in search (and rapid chip clicks) coalesce into one
  // fetch rather than one per keystroke.
  useEffect(() => {
    const id = setTimeout(() => void fetchReset(), 250);
    return () => clearTimeout(id);
  }, [fetchReset]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (loadingMore || !cursor) return;
    const runId = runIdRef.current;
    setLoadingMore(true);
    try {
      const res = await fetchWithTimeout(`/api/teacher/library/materials?${buildQuery(cursor)}`);
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TeacherLibraryMaterialsPage;
      if (runId !== runIdRef.current) return; // a filter change reset the list mid-flight
      setItems((prev) => [...prev, ...page.items]);
      cursorRef.current = page.nextCursor;
    } catch {
      // Swallow — the Load more button just stays available to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [buildQuery, loadingMore]);

  const anyFilter = Boolean(
    filters.category || filters.level || filters.type || filters.visibility || q,
  );

  const chipClass = (selected: boolean) =>
    cn(
      "rounded-full border px-2.5 py-1 text-xs transition-colors",
      selected ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
    );

  const visibilityLabel = (v: LibraryVisibility) => {
    if (v === "all") return t("web.materials.visibilityAll");
    if (v === "exact") return t("web.materials.visibilityExact");
    return t("web.materials.visibilityAtOrBelowShort");
  };

  return (
    <div className="space-y-3">
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("web.materials.searchPlaceholder")}
        aria-label={t("web.materials.searchPlaceholder")}
        data-testid="call-library-search"
      />

      <button
        type="button"
        onClick={() => setFiltersOpen((v) => !v)}
        className="text-muted-foreground text-xs underline underline-offset-2"
        data-testid="call-library-filters-toggle"
      >
        {t("web.materials.filtersToggle")}
      </button>

      {filtersOpen && (
        <div className="bg-muted/30 space-y-2 rounded-md border p-2">
          <ChipRow
            label={t("web.materials.sortLabel")}
            options={[
              { value: "recent", label: t("web.materials.sortRecent") },
              { value: "oldest", label: t("web.materials.sortOldest") },
            ]}
            active={sort}
            onSelect={(v) => setSort(v as "recent" | "oldest")}
            chipClass={chipClass}
            allowClear={false}
          />
          {meta && meta.focusGroups.length > 0 && (
            <ChipRow
              label={t("web.materials.filterCategory")}
              options={meta.focusGroups.map((g) => ({
                value: g.categoryId,
                label: g.categoryLabel,
              }))}
              active={filters.category}
              allLabel={t("web.materials.filterAll")}
              onSelect={(v) => setFilters((f) => ({ ...f, category: v }))}
              chipClass={chipClass}
            />
          )}
          {meta && meta.levels.length > 0 && (
            <ChipRow
              label={t("web.materials.filterLevel")}
              options={meta.levels.map((l) => ({ value: l.id, label: l.label }))}
              active={filters.level}
              allLabel={t("web.materials.filterAll")}
              onSelect={(v) => setFilters((f) => ({ ...f, level: v }))}
              chipClass={chipClass}
            />
          )}
          <ChipRow
            label={t("web.materials.filterType")}
            options={(["content", "file", "link"] as const).map((k) => ({
              value: k,
              label: t(`materials.contentType.${k === "content" ? "write" : k}`),
            }))}
            active={filters.type}
            allLabel={t("web.materials.filterAll")}
            onSelect={(v) =>
              setFilters((f) => ({ ...f, type: v as MaterialAttachmentKind | null }))
            }
            chipClass={chipClass}
          />
          <ChipRow
            label={t("web.materials.filterVisibility")}
            options={(["at_or_below", "exact", "all"] as const).map((v) => ({
              value: v,
              label: visibilityLabel(v),
            }))}
            active={filters.visibility}
            allLabel={t("web.materials.filterAll")}
            onSelect={(v) =>
              setFilters((f) => ({ ...f, visibility: v as LibraryVisibility | null }))
            }
            chipClass={chipClass}
          />
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : error && items.length === 0 ? (
        <div className="space-y-2">
          <p className="text-destructive text-sm">{t("common.error")}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchReset()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {anyFilter ? t("web.materials.noResults") : t("web.materials.noMaterialsYet")}
        </p>
      ) : (
        <>
          <ul className="space-y-2" data-testid="call-library-list">
            {items.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  data-testid={`call-library-item-${m.id}`}
                  onClick={() => onSelect(toCallMaterial(m))}
                  className="border-border hover:bg-muted flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left"
                >
                  <span className="text-sm font-medium">
                    {m.label ??
                      t(
                        m.attachmentKind === "file"
                          ? "materials.fileAttachment"
                          : m.attachmentKind === "link"
                            ? "materials.linkAttachment"
                            : "web.materials.classContent",
                      )}
                  </span>
                  <span className="text-muted-foreground text-xs">{m.levelLabel}</span>
                </button>
              </li>
            ))}
          </ul>
          {cursorRef.current && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              data-testid="call-library-load-more"
            >
              {t("web.admin.storage.loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function ChipRow({
  label,
  options,
  active,
  allLabel,
  allowClear = true,
  onSelect,
  chipClass,
}: {
  label: string;
  options: { value: string; label: string }[];
  active: string | null;
  allLabel?: string;
  allowClear?: boolean;
  onSelect: (value: string | null) => void;
  chipClass: (selected: boolean) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground w-16 shrink-0 text-sm font-semibold">{label}</span>
      {allowClear && allLabel && (
        <button type="button" onClick={() => onSelect(null)} className={chipClass(active === null)}>
          {allLabel}
        </button>
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onSelect(allowClear && active === o.value ? null : o.value)}
          className={chipClass(active === o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
