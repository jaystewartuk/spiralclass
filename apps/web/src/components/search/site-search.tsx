"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  FileText,
  GraduationCap,
  HelpCircle,
  Inbox,
  Library,
  type LucideIcon,
  Package,
  Search,
  User,
  X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useLocale, useT } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { StringKey } from "@/lib/i18n-translate";
import { stepActiveIndex, useListKeyboardNav } from "@/lib/keyboard-list-nav";
import {
  indexSearchEntries,
  searchEntries,
  type SearchEntry,
  type SearchKind,
} from "@/lib/search/match";
import { searchWithinLinks, type SearchAudience } from "@/lib/search/within";
import { studentDestinations } from "@/lib/search/student-destinations";
import { teacherDestinations, type SearchDestination } from "@/lib/search/teacher-destinations";
import { cn } from "@/lib/utils";

// The site-wide search: one box, reachable from the header on every page of
// the teacher app and the student portal, and from ⌘K / Ctrl+K anywhere. It
// finds pages and actions (built here, from the nav registries), the person's
// own records and the help articles (fetched from /api/{audience}/search each
// time it opens). docs/features/search.md is the behaviour; lib/search/ is
// the logic, kept out of this file so it can be tested without a browser.

type Row = SearchEntry & { icon?: LucideIcon };

const KIND_ICONS: Record<SearchKind, LucideIcon> = {
  page: FileText,
  action: ArrowRight,
  student: User,
  teacher: GraduationCap,
  class: BookOpen,
  package: Package,
  lead: Inbox,
  material: Library,
  help: HelpCircle,
};

const KIND_LABELS: Record<SearchKind, StringKey> = {
  page: "web.search.kind.page",
  action: "web.search.kind.action",
  student: "web.search.kind.student",
  teacher: "web.search.kind.teacher",
  class: "web.search.kind.class",
  package: "web.search.kind.package",
  lead: "web.search.kind.lead",
  material: "web.search.kind.material",
  help: "web.search.kind.help",
};

type RecordsState = { status: "idle" | "loading" | "ready" | "error"; entries: SearchEntry[] };

// The platform never changes under a page, so there is nothing to subscribe to.
const subscribeNever = () => () => {};

export function SiteSearch({
  audience,
  bookingSlug,
}: {
  audience: SearchAudience;
  bookingSlug?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<RecordsState>({ status: "idle", entries: [] });
  // Server snapshot is "not a Mac": the hint renders as Ctrl K until hydration
  // says otherwise, which is the right answer for most of the world anyway.
  const isMac = useSyncExternalStore(
    subscribeNever,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false,
  );
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  // Only the newest request may write: a slow response to an earlier open
  // must not overwrite a fresher one.
  const latestRequest = useRef(0);

  // Fresh records on every open: a student added a minute ago must be
  // findable. The previous index stays usable while the new one loads, and
  // pages and help work even if the fetch fails.
  const loadRecords = useCallback(() => {
    const request = ++latestRequest.current;
    const settle = (data: { entries: SearchEntry[] } | null) => {
      if (request !== latestRequest.current) return;
      setRecords((prev) =>
        data ? { status: "ready", entries: data.entries } : { ...prev, status: "error" },
      );
    };
    setRecords((prev) => ({ ...prev, status: "loading" }));
    fetchWithTimeout(`/api/${audience}/search`)
      .then((res) => (res.ok ? (res.json() as Promise<{ entries: SearchEntry[] }>) : null))
      .then(settle, () => settle(null));
  }, [audience]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) loadRecords();
      else setQuery("");
    },
    [loadRecords],
  );

  // ⌘K / Ctrl+K from anywhere, including from inside a text field — it is the
  // one chord no field in the product uses, and a teacher reaching for search
  // is usually mid-task on some other page.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const destinations: SearchDestination[] = useMemo(
    () =>
      audience === "teacher"
        ? teacherDestinations({ locale, t, bookingSlug })
        : studentDestinations({ locale, t }),
    [audience, locale, t, bookingSlug],
  );

  const index = useMemo(
    () => indexSearchEntries<Row>([...destinations, ...records.entries]),
    [destinations, records.entries],
  );

  const trimmed = query.trim();
  const rows: Row[] = useMemo(() => {
    if (!trimmed) return destinations.filter((d) => d.suggested);
    const within: Row[] = searchWithinLinks(audience, trimmed).map((link) => ({
      id: `within.${link.id}`,
      kind: "action",
      label: t(link.label, { query: trimmed }),
      href: link.href,
      icon: Search,
    }));
    return [...searchEntries(index, trimmed), ...within];
  }, [trimmed, destinations, index, audience, t]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  function go(row: Row) {
    close();
    if (row.external) {
      window.open(row.href, "_blank", "noopener,noreferrer");
    } else {
      router.push(row.href);
    }
  }

  const {
    activeIndex: rawActiveIndex,
    setActiveIndex,
    onKeyDown,
  } = useListKeyboardNav({
    itemCount: rows.length,
    onCommit: (i) => {
      const row = rows[i];
      if (row) go(row);
    },
    onClose: close,
  });
  // The list can shrink under the highlight — the records arrive, or the
  // dialog reopens on the shorter suggestions list — so render the index the
  // same way Enter resolves it: clamped to the rows that exist.
  const activeIndex = stepActiveIndex(rawActiveIndex, "", rows.length);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const shortcut = t(isMac ? "web.search.shortcut.mac" : "web.search.shortcut.other");
  const placeholder = t(
    audience === "teacher" ? "web.search.placeholder.teacher" : "web.search.placeholder.student",
  );
  const activeRow = rows[activeIndex];

  return (
    <>
      {/* An icon, like the bell beside it: the header has no room for a
      labelled field at tablet widths, and the shortcut is in the tooltip. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onOpenChange(true)}
        aria-label={t("web.search.trigger")}
        aria-keyshortcuts="Meta+K Control+K"
        title={`${t("web.search.trigger")} (${shortcut})`}
        className="shrink-0 text-muted-foreground"
      >
        <Search className="h-5 w-5" aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          hideClose
          aria-describedby={undefined}
          // Each open starts at the top; focus still lands in the box.
          onOpenAutoFocus={() => setActiveIndex(0)}
          // Top-anchored rather than centred: the list grows downward as she
          // types, and a centred box would jump up to make room.
          className="top-3 flex max-h-sheet max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-24 sm:max-h-sheet-desktop"
        >
          <DialogTitle className="sr-only">{t("web.search.dialogTitle")}</DialogTitle>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeRow ? `${listId}-${activeIndex}` : undefined}
              aria-label={placeholder}
              placeholder={placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // A new query starts at the top of its own results.
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              autoComplete="off"
              spellCheck={false}
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-hidden placeholder:text-muted-foreground"
            />
            <DialogPrimitive.Close
              aria-label={t("common.close")}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <p className="px-2 pt-1 pb-2 text-xs font-semibold text-muted-foreground">
              {trimmed ? t("web.search.results") : t("web.search.suggested")}
            </p>
            {trimmed && rows.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                {t("web.search.noMatches", { query: trimmed })}
              </p>
            ) : (
              <ul id={listId} ref={listRef} role="listbox" aria-label={placeholder}>
                {rows.map((row, i) => {
                  const Icon = row.icon ?? KIND_ICONS[row.kind];
                  return (
                    <li
                      key={row.id}
                      id={`${listId}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === activeIndex}
                      onMouseMove={() => setActiveIndex(i)}
                      onClick={() => go(row)}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2",
                        i === activeIndex && "bg-accent text-accent-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {row.label}
                          {row.archived ? (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {t("web.search.archived")}
                            </span>
                          ) : null}
                        </span>
                        {row.detail ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.detail}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(KIND_LABELS[row.kind])}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {records.status === "loading" && records.entries.length === 0 ? (
              <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                {t(
                  audience === "teacher"
                    ? "web.search.loadingRecords.teacher"
                    : "web.search.loadingRecords.student",
                )}
              </p>
            ) : null}
            {records.status === "error" ? (
              <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                {t(
                  audience === "teacher"
                    ? "web.search.recordsFailed.teacher"
                    : "web.search.recordsFailed.student",
                )}
              </p>
            ) : null}
          </div>

          <p className="hidden border-t border-border px-4 py-2 text-xs text-muted-foreground desktop:block">
            {t("web.search.keyboardHint")}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
