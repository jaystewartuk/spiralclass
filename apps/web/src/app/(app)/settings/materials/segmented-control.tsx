"use client";

import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// A single-choice control over a small, fixed set of options — the shape the AI
// material style page wants three times over (tone, learner age, vocabulary).
//
// It is a real WAI-ARIA radiogroup rather than a row of buttons wearing
// `role="radio"`. The version this replaces gave every option its own tab stop
// and no arrow keys, so a keyboard user paid five tabs to cross one question
// and had no way at all to change the answer without a pointer. Here the group
// is ONE tab stop (roving tabindex, landing on the selected option) and the
// arrows, Home and End move between options as a native radio group does.
//
// Server actions can't read React state, so the value is mirrored into a hidden
// <input> — the same convention AutoSurfaceMaterialsForm uses.

export type SegmentOption = {
  /** "" means "unset"; the column stays null and the prompt gets no directive. */
  value: string;
  label: string;
};

export function SegmentedControl({
  name,
  value,
  formValue,
  onChange,
  options,
  labelledBy,
  describedBy,
  className,
}: {
  name: string;
  /** The option shown as selected. */
  value: string;
  /**
   * What the form posts, when that differs from what is shown. Vocabulary needs
   * this: a null column displays as "Everyday" (what it resolves to) while it
   * must still post "" so an untouched row stays null.
   */
  formValue?: string;
  onChange: (value: string) => void;
  options: readonly SegmentOption[];
  /** id of the heading that names this group. */
  labelledBy: string;
  /** id of the effect line, so the answer is announced with its meaning. */
  describedBy?: string;
  className?: string;
}) {
  const groupId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function move(to: number) {
    const next = (to + options.length) % options.length;
    onChange(options[next]!.value);
    // Focus follows selection, as it does in a native radio group.
    refs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(options.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <>
      <input type="hidden" name={name} value={formValue ?? value} />
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        // Equal columns while the options would otherwise wrap into a ragged
        // block on a phone; natural widths once one row has room for them.
        className={cn("grid grid-cols-2 gap-2 sm:flex sm:flex-wrap", className)}
      >
        {options.map((option, index) => {
          const active = index === selectedIndex;
          return (
            <Button
              key={option.value || `${groupId}-unset`}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              // The roving tab stop: one per group, on the current answer.
              tabIndex={active ? 0 : -1}
              variant={active ? "default" : "outline"}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="w-full sm:w-auto"
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </>
  );
}
