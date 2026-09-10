"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useListKeyboardNav } from "@/lib/keyboard-list-nav";
import { useT } from "@/components/locale-provider";

// Searchable, grouped multi-select for focus tags — the collapsed replacement
// for the always-expanded pill grid (FocusTagPicker), so a teacher with many
// tags isn't scrolling past all of them to reach Save. Same shape/API as the
// old picker (groups + a Set of selected ids + onToggle), so the parent forms
// keep their state and their hidden `focusTagId` inputs unchanged. Modeled on
// ui/combobox.tsx (button trigger + filtered listbox + keyboard nav), but it
// stays open on toggle and shows the current selection as removable chips.

export type FocusGroup = {
  categoryId: string;
  categoryLabel: string;
  tags: { id: string; label: string }[];
};

type FlatTag = { categoryId: string; categoryLabel: string; id: string; label: string };

export function FocusTagSelect({
  groups,
  selected,
  onToggle,
  id,
}: {
  groups: FocusGroup[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  id?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Flat, in-order list of every tag (used for filtering + keyboard nav). The
  // dropdown re-groups it under category headers for display.
  const allTags = useMemo<FlatTag[]>(
    () =>
      groups.flatMap((g) =>
        g.tags.map((tag) => ({
          categoryId: g.categoryId,
          categoryLabel: g.categoryLabel,
          id: tag.id,
          label: tag.label,
        })),
      ),
    [groups],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((tag) => tag.label.toLowerCase().includes(q));
  }, [allTags, query]);

  // Group the filtered flat list back into sections while remembering each
  // tag's index into `filtered`, so keyboard nav and the rendered rows agree.
  const filteredGroups = useMemo(() => {
    const out: {
      categoryId: string;
      categoryLabel: string;
      tags: { tag: FlatTag; index: number }[];
    }[] = [];
    filtered.forEach((tag, index) => {
      const last = out[out.length - 1];
      if (last && last.categoryId === tag.categoryId) {
        last.tags.push({ tag, index });
      } else {
        out.push({
          categoryId: tag.categoryId,
          categoryLabel: tag.categoryLabel,
          tags: [{ tag, index }],
        });
      }
    });
    return out;
  }, [filtered]);

  // Selected chips, in the catalog's own order (not selection order).
  const selectedTags = useMemo(
    () => allTags.filter((tag) => selected.has(tag.id)),
    [allTags, selected],
  );

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const { activeIndex, setActiveIndex, onKeyDown } = useListKeyboardNav({
    itemCount: filtered.length,
    // Multi-select: toggle and keep the panel open so several tags can be
    // picked in one visit.
    onCommit: (index) => {
      const tag = filtered[index];
      if (tag) onToggle(tag.id);
    },
    onClose: () => setOpen(false),
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);
  useEffect(() => {
    setActiveIndex(0);
  }, [query, setActiveIndex]);

  if (groups.length === 0) return null;

  const triggerLabel =
    selected.size > 0
      ? t("classContent.author.focusSelectedCount", { count: selected.size })
      : t("classContent.author.focusAdd");

  return (
    <div ref={rootRef} className="relative space-y-1.5">
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "border-input flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
          "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden",
          selected.size === 0 && "text-muted-foreground",
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground absolute z-50 mt-1 w-full min-w-64 rounded-md border shadow-md">
          <div className="p-1">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("classContent.author.focusSearch")}
              aria-label={t("classContent.author.focusSearch")}
              autoComplete="off"
              className="placeholder:text-muted-foreground flex h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-hidden"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-multiselectable
            className="max-h-60 overflow-y-auto p-1"
          >
            {filtered.length === 0 ? (
              <li className="text-muted-foreground px-2 py-1.5 text-sm">
                {t("classContent.author.focusEmpty")}
              </li>
            ) : (
              filteredGroups.map((group) => (
                <li key={group.categoryId} role="presentation">
                  <p className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-sm">
                    {group.categoryLabel}
                  </p>
                  <ul role="presentation">
                    {group.tags.map(({ tag, index }) => {
                      const isSelected = selected.has(tag.id);
                      const isActive = index === activeIndex;
                      return (
                        <li
                          key={tag.id}
                          role="option"
                          aria-selected={isSelected}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => onToggle(tag.id)}
                          className={cn(
                            "flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                            isActive && "bg-accent text-accent-foreground",
                          )}
                        >
                          <span className="truncate">{tag.label}</span>
                          {isSelected ? (
                            <Check className="ml-2 h-4 w-4 shrink-0" aria-hidden="true" />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => onToggle(tag.id)}
              aria-label={t("classContent.author.focusRemove", { label: tag.label })}
              className="border-primary bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors hover:opacity-90"
            >
              {tag.label}
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
