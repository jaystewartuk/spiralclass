"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { useListKeyboardNav } from "@/lib/keyboard-list-nav";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

type SearchResult = { id: string; name: string; email: string };
type SearchResponse = { teachers: SearchResult[]; students: SearchResult[] };
type FlatResult = SearchResult & { hrefBase: string; groupLabel: string };

const DEBOUNCE_MS = 300;

// Nav-bar quick jump: type a teacher/student's name or email, land on their
// detail page. Deliberately narrow (2 entity types, top 5 each via
// /api/admin/search) rather than a fuzzy command palette over every admin
// section — see the plan's scope note on the nav "supercharge." Keyboard
// navigation (Arrow/Enter/Escape) is built on the shared
// `useListKeyboardNav` primitive, the same one `components/ui/combobox.tsx`
// uses — so any future search box on the site can reuse it too.
export function AdminQuickSearch() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      fetchWithTimeout(`/api/admin/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setResults(data))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const flatResults: FlatResult[] = results
    ? [
        ...results.teachers.map((r) => ({
          ...r,
          hrefBase: "/admin/teachers",
          groupLabel: t("web.admin.nav.teachers"),
        })),
        ...results.students.map((r) => ({
          ...r,
          hrefBase: "/admin/students",
          groupLabel: t("web.admin.nav.students"),
        })),
      ]
    : [];

  function close() {
    setOpen(false);
    setQuery("");
    setResults(null);
  }

  const { activeIndex, setActiveIndex, onKeyDown } = useListKeyboardNav({
    itemCount: flatResults.length,
    onCommit: (index) => {
      const result = flatResults[index];
      if (!result) return;
      router.push(`${result.hrefBase}/${result.id}`);
      close();
    },
    onClose: close,
  });

  const hasResults = flatResults.length > 0;
  let lastGroupLabel: string | null = null;

  return (
    <div ref={containerRef} className="relative">
      {open ? (
        <div className="bg-background flex items-center gap-1 rounded-md border px-2">
          <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={hasResults}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-activedescendant={hasResults ? `${listId}-option-${activeIndex}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("web.admin.quickSearch.placeholder")}
            className="placeholder:text-muted-foreground h-9 w-56 bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            aria-label={t("web.admin.quickSearch.close")}
            onClick={close}
            className="text-muted-foreground hover:bg-muted/60 rounded p-1"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={t("web.admin.quickSearch.trigger")}
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors"
        >
          <Search className="h-4 w-4" aria-hidden />
        </button>
      )}

      {open && query.trim() ? (
        <div className="bg-popover text-popover-foreground absolute top-full right-0 z-20 mt-2 w-72 rounded-md border p-2 shadow-md">
          {loading ? (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              {t("web.admin.quickSearch.searching")}
            </p>
          ) : hasResults ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={t("web.admin.quickSearch.placeholder")}
              className="space-y-2"
            >
              {flatResults.map((result, index) => {
                const showGroupLabel = result.groupLabel !== lastGroupLabel;
                lastGroupLabel = result.groupLabel;
                return (
                  <li key={`${result.hrefBase}-${result.id}`} role="presentation">
                    {showGroupLabel ? (
                      <div className="text-muted-foreground px-2 pb-1 text-sm font-semibold">
                        {result.groupLabel}
                      </div>
                    ) : null}
                    <div
                      id={`${listId}-option-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        router.push(`${result.hrefBase}/${result.id}`);
                        close();
                      }}
                      className={cn(
                        "block cursor-pointer rounded px-2 py-1.5 text-sm",
                        index === activeIndex && "bg-accent text-accent-foreground",
                      )}
                    >
                      <div className="font-medium">{result.name}</div>
                      <div className="text-muted-foreground text-xs">{result.email}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              {t("web.admin.quickSearch.noMatches")}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
