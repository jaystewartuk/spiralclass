"use client";

import { useState, useTransition } from "react";
import { saveReadingPreferences } from "@/app/actions/reading";
import { useT } from "@/components/locale-provider";
import { READING_SCALES, type ReadingPreferences } from "@/lib/reading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The reading controls (D-140).
 *
 * Three settings, not a panel of sliders: dyslexia does not present one way,
 * but an unbounded control is one nobody can describe afterwards and that
 * breaks every layout. Each is a small named set.
 *
 * The preview is the page itself. There is no sample paragraph, because a
 * sample tells you how the sample looks — the change applies live to whatever
 * the reader is already looking at, which is the only honest preview.
 */

type Group<T extends string | number | boolean> = {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
};

function Segmented<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
}: Group<T>) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-foreground mb-2 font-bold">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Button
              key={String(option.value)}
              type="button"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className="font-bold"
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ReadingControls({
  initial,
  className,
}: {
  initial: ReadingPreferences;
  className?: string;
}) {
  const t = useT();
  const [prefs, setPrefs] = useState(initial);
  const [, startTransition] = useTransition();

  /** Apply immediately, persist in the background. A reader adjusting text size
   * is doing it because the current size is uncomfortable; waiting for a round
   * trip to see the result is the wrong way round. */
  function update(next: ReadingPreferences) {
    setPrefs(next);
    const root = document.documentElement;
    root.style.setProperty("--reading-scale", String(next.scale));
    root.style.setProperty("--reading-tint", next.tint ? "1" : "0");
    const spacing = [
      { tracking: "0.012em", word: "0.04em", leading: "1.6" },
      { tracking: "0.045em", word: "0.12em", leading: "1.8" },
      { tracking: "0.075em", word: "0.2em", leading: "2" },
    ][next.spacing];
    root.style.setProperty("--reading-tracking", spacing.tracking);
    root.style.setProperty("--reading-word", spacing.word);
    root.style.setProperty("--reading-leading", spacing.leading);
    startTransition(() => void saveReadingPreferences(next));
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <Segmented
        label={t("web.reading.size")}
        value={prefs.scale}
        options={[
          { value: READING_SCALES[0], label: t("web.reading.sizeNormal") },
          { value: READING_SCALES[1], label: t("web.reading.sizeLarger") },
          { value: READING_SCALES[2], label: t("web.reading.sizeLargest") },
        ]}
        onChange={(scale) => update({ ...prefs, scale })}
      />
      <Segmented
        label={t("web.reading.spacing")}
        value={prefs.spacing}
        options={[
          { value: 0 as const, label: t("web.reading.spacingNormal") },
          { value: 1 as const, label: t("web.reading.spacingWide") },
          { value: 2 as const, label: t("web.reading.spacingWidest") },
        ]}
        onChange={(spacing) => update({ ...prefs, spacing })}
      />
      <Segmented
        label={t("web.reading.tint")}
        value={prefs.tint}
        options={[
          { value: false, label: t("web.reading.tintOff") },
          { value: true, label: t("web.reading.tintOn") },
        ]}
        onChange={(tint) => update({ ...prefs, tint })}
      />
      <p className="text-muted-foreground text-sm">{t("web.reading.browserNote")}</p>
    </div>
  );
}
