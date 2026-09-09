"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BookOpen, CircleHelp, Hash, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/locale-provider";
import { searchHelpEntries, type HelpEntryKind, type HelpSearchEntry } from "@/lib/help/search";
import { cn } from "@/lib/utils";

/**
 * Instant search over the help centre, jumping to an anchor on the same page.
 *
 * NOT A COMBOBOX, deliberately. The ARIA combobox pattern moves focus nowhere
 * and drives the list with `aria-activedescendant`, which means every result
 * has to be a non-focusable element pretending to be an option — and the
 * results here are links, whose whole value is that they behave like links
 * (open in a new tab, copy the address, land in the browser's history). So
 * this is a plain search field plus a list of real links: reachable by Tab,
 * announced by a polite status line, with Arrow keys as an accelerator rather
 * than as the only way through.
 *
 * The index is built on the server from the same docs the page renders below
 * (lib/help/search.ts), so this is a filter over what is already on the page,
 * never a second source of answers that could disagree with it.
 */

const KIND_ICON: Record<HelpEntryKind, typeof Search> = {
  guide: BookOpen,
  section: Hash,
  question: CircleHelp,
};

export function HelpSearch({ entries }: { entries: HelpSearchEntry[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const statusId = useId();

  const trimmed = query.trim();
  const results = useMemo(() => searchHelpEntries(entries, trimmed), [entries, trimmed]);
  const searching = trimmed.length > 0;
  const open = searching && !dismissed;

  // Close on a click anywhere else, the way every other overlay on the web
  // does. On `pointerdown` rather than on the input's `blur`, because blur
  // fires BEFORE the click it was caused by: unmounting the panel there loses
  // the click on the very result the reader was aiming at.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Arrow keys walk the rendered links by moving real focus, so the browser's
  // own focus ring is the selection indicator and nothing has to be mirrored
  // into ARIA.
  const focusResult = (index: number) => {
    const links = listRef.current?.querySelectorAll<HTMLAnchorElement>("a");
    if (!links || links.length === 0) return;
    const clamped = (index + links.length) % links.length;
    links[clamped]?.focus();
  };

  const clear = () => {
    setQuery("");
    setDismissed(false);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t("web.help.search.label")}
      </label>
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={`${listId}-input`}
        ref={inputRef}
        type="search"
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setDismissed(false);
            focusResult(0);
          } else if (event.key === "Escape" && trimmed) {
            event.preventDefault();
            setQuery("");
            setDismissed(false);
          }
        }}
        placeholder={t("web.help.search.placeholder")}
        aria-describedby={statusId}
        // Taller than a form field and rounded to match the hero it sits in:
        // this is the page's primary action, not one input among several. The
        // right padding leaves room for the clear button.
        // `no-native-clear` (globals.css) suppresses WebKit's own clear
        // button; this field supplies one of its own and two of them side by
        // side reads as a rendering fault.
        className="no-native-clear h-12 rounded-full pl-12 pr-12 text-base lg:h-12 lg:text-base"
      />
      {searching && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={clear}
          className="absolute right-1 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full"
        >
          <X className="h-4 w-4" aria-hidden />
          <span className="sr-only">{t("web.help.search.clear")}</span>
        </Button>
      )}

      {/* The count, announced rather than only shown — a screen-reader user
          typing into the field otherwise gets no signal that the page changed
          under her. `role="status"` is polite by definition. */}
      <p id={statusId} role="status" className="sr-only">
        {open ? t("web.help.search.resultCount", { count: results.length }) : ""}
      </p>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border bg-popover text-left shadow-brand-lg",
          )}
        >
          {results.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {t("web.help.search.noResults", { query: trimmed })}
            </p>
          ) : (
            <ul ref={listRef} className="max-h-96 divide-y overflow-y-auto">
              {results.map((result, index) => {
                const Icon = KIND_ICON[result.kind];
                return (
                  <li key={`${result.kind}-${result.id}-${result.label}`}>
                    <a
                      href={`#${result.id}`}
                      onClick={clear}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          focusResult(index + 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          if (index === 0) inputRef.current?.focus();
                          else focusResult(index - 1);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          clear();
                        }
                      }}
                      className="flex items-start gap-3 px-5 py-3 hover:bg-muted focus-visible:bg-muted"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">
                          {result.label}
                        </span>
                        {result.context && (
                          <span className="block text-xs text-subtle">{result.context}</span>
                        )}
                        {/* `line-clamp-*` sets `display: -webkit-box`, so the
                            snippet must NOT also carry `block` — the later
                            utility wins and the clamp silently does nothing.
                            Two lines: enough of an answer to recognise the
                            right result, not so much that eight results stop
                            being a list. */}
                        {result.snippet && (
                          <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {result.snippet}
                          </span>
                        )}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
