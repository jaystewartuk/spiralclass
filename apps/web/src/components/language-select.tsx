"use client";

import { useId, useRef } from "react";
import {
  localeOptions,
  localizedPath,
  publicUrlLocale,
  unlocalizedPath,
  type LocalePreference,
} from "@spiralclass/shared";
import { chooseLocaleAction, setLocaleAction } from "@/app/actions/locale";
import { hardNavigate } from "@/lib/hard-navigate";
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

  // On a public page whose URL names its language (D-193), the cookie cannot
  // change the page: `/es/pricing` is Spanish whatever it says. So the choice
  // is saved, and then the chosen language's URL for this page is loaded —
  // fully, because the root layout carries the language too and a client-side
  // navigation would keep the old one. Everywhere else the form submits as it
  // always has, and the action's revalidation re-renders the tree.
  async function onChange() {
    const form = formRef.current;
    if (!form) return;
    const { pathname, search, hash } = window.location;
    if (publicUrlLocale(pathname) === null) {
      form.requestSubmit();
      return;
    }
    const result = await chooseLocaleAction(new FormData(form));
    if (!result) return;
    hardNavigate(`${localizedPath(unlocalizedPath(pathname), result.locale)}${search}${hash}`);
  }
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
        className={cn(field ? "text-xs font-bold text-foreground" : "sr-only")}
        htmlFor={selectId}
      >
        {t("settings.language")}
      </label>
      <select
        id={selectId}
        name="locale"
        defaultValue={current}
        aria-label={t("settings.language")}
        onChange={() => void onChange()}
        className={cn(
          "cursor-pointer rounded-md border border-input bg-background focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden",
          field
            ? "h-11 w-full px-3 text-sm text-foreground lg:h-10"
            : "px-2 py-1 text-xs text-muted-foreground hover:text-foreground",
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
