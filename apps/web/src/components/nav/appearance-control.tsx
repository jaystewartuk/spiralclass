"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useT } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";

// Light / Dark / System, as a segmented control.
//
// It replaces a single text link that said "Dark" and toggled to light. Three
// things were wrong with that: it never offered SYSTEM, which is the app's own
// default (theme-provider.tsx) and therefore unreachable once a reader had
// touched the control even once; the word it showed was the theme it would
// switch TO, so it read as a label for the current state and said the opposite
// of the truth; and at 15px with no border it was the one control in the menu
// that didn't look like a control.
//
// Shape borrowed from ReadingControls' `Segmented` (D-140) rather than
// invented — the two do the same job on the same kind of setting, and a reader
// who has met one should recognise the other.

const OPTIONS = [
  { value: "light", labelKey: "web.nav.appearanceLight" },
  { value: "dark", labelKey: "web.nav.appearanceDark" },
  { value: "system", labelKey: "web.nav.appearanceSystem" },
] as const;

export function AppearanceControl() {
  const { theme, setTheme } = useTheme();
  const t = useT();
  // The stored preference is only readable on the client, so the first paint
  // has to be identical on both sides of hydration: render the control with
  // nothing pressed, then let the effect fill the selection in.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <fieldset className="min-w-0">
      <legend className="text-foreground mb-2 text-xs font-bold">{t("web.nav.appearance")}</legend>
      <div className="grid grid-cols-3 gap-1.5">
        {OPTIONS.map((option) => {
          const selected = mounted && theme === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              onClick={() => setTheme(option.value)}
              className="px-2 font-semibold"
            >
              {t(option.labelKey)}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
