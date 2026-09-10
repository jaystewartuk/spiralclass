"use client";

import { useId, useRef } from "react";
import { localeOptions, type LocalePreference } from "@spiralclass/shared";
import { setLocaleAction } from "@/app/actions/locale";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

// The generic language menu — a single <select> generated entirely from the
// shared locale registry (localeOptions) plus a leading "System Default" row.
// Adding a language never touches this file: it renders whatever LOCALES holds.
// Submits the chosen LocalePreference through the setLocaleAction server action;
// the action advances the `locale` cookie and revalidates, so the surrounding
// server tree re-renders in the new language with no full page reload.
//
// Two variants, because the same control appears in two kinds of place:
//
//   compact  the public site footer's preferences pill — an inline chip
//            beside the theme toggle.
//   field    the nav menus — a full-width form field with a VISIBLE label.
//            The label is the point: on its own the control reads "System
//            Default", which says nothing about what it sets, and that was
//            the least legible thing in the mobile menu.
//
// The element id is per-instance (`useId`) rather than the fixed
// "language-select" it was: the picker renders in the site footer AND in the
// nav menu on the same page, so a constant id meant duplicate ids in the
// document and a <label for> that pointed at whichever one parsed first.
export function LanguageSelect({
  current,
  variant = "compact",
}: {
  current: LocalePreference;
  variant?: "compact" | "field";
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const t = useT();
  const selectId = useId();
  const options = localeOptions(t("settings.language.system"));
  const field = variant === "field";

  return (
    <form
      ref={formRef}
      action={setLocaleAction}
      className={cn(field ? "flex min-w-0 flex-col gap-2" : "inline-flex")}
    >
      <label
        className={cn(field ? "text-foreground text-xs font-bold" : "sr-only")}
        htmlFor={selectId}
      >
        {t("settings.language")}
      </label>
      <select
        id={selectId}
        name="locale"
        defaultValue={current}
        aria-label={t("settings.language")}
        onChange={() => formRef.current?.requestSubmit()}
        className={cn(
          "border-input bg-background focus-visible:ring-ring cursor-pointer rounded-md border focus-visible:ring-3 focus-visible:outline-none",
          field
            ? "text-foreground h-11 w-full px-3 text-sm lg:h-10"
            : "text-muted-foreground hover:text-foreground px-2 py-1 text-xs",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}
