"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useListKeyboardNav } from "@/lib/keyboard-list-nav";

// A lightweight, dependency-free searchable single-select. shadcn's canonical
// Combobox pulls in cmdk + a popover primitive we don't ship; this covers the
// same need (type-to-filter over a long list — e.g. ~250 countries) with a
// button + filtered listbox and keyboard support, and posts its value through a
// hidden input so it works inside a plain <form action={serverAction}>.

export type ComboboxOption = { value: string; label: string };

type Props = {
  options: ComboboxOption[];
  value: string;
  onValueChange: (value: string) => void;
  name?: string;
  id?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
  // Trigger-button override, e.g. rendering a compact "+52" dial code instead
  // of the full option label — used to pair this with another control (see
  // phone-number-field.tsx) as one visual field instead of two stacked ones.
  className?: string;
  formatSelected?: (option: ComboboxOption) => string;
};

export function Combobox({
  options,
  value,
  onValueChange,
  name,
  id,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  disabled,
  className,
  formatSelected,
  ...aria
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function commit(v: string) {
    onValueChange(v);
    setOpen(false);
  }

  const { activeIndex, setActiveIndex, onKeyDown } = useListKeyboardNav({
    itemCount: filtered.length,
    onCommit: (index) => {
      const opt = filtered[index];
      if (opt) commit(opt.value);
    },
    onClose: () => setOpen(false),
  });

  // Focus the search box when the list opens; keep the active row in range.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);
  useEffect(() => {
    setActiveIndex(0);
  }, [query, setActiveIndex]);

  return (
    <div ref={rootRef} className="relative">
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        {...aria}
        className={cn(
          "border-input flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
          "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          !selected && "text-muted-foreground",
          className,
        )}
      >
        <span className="truncate">
          {selected ? (formatSelected ? formatSelected(selected) : selected.label) : placeholder}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
      </button>

      {open && (
        // min-w keeps the panel usable even when the trigger itself is a
        // compact chip (e.g. the phone dial-code chip, ~72px) — without it,
        // the search input and every country name inherit that same
        // trigger-width via w-full, becoming unreadable/untappable.
        <div className="bg-popover text-popover-foreground absolute z-50 mt-1 w-full min-w-64 rounded-md border shadow-md">
          <div className="p-1">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              autoComplete="off"
              className="placeholder:text-muted-foreground flex h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-hidden"
            />
          </div>
          <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="text-muted-foreground px-2 py-1.5 text-sm">{emptyText}</li>
            ) : (
              filtered.map((opt, i) => {
                const isSelected = opt.value === value;
                const isActive = i === activeIndex;
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(opt.value)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected ? (
                      <Check className="ml-2 h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
