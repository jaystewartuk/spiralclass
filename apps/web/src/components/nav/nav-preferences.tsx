"use client";

import type { ReactNode } from "react";
import { useT } from "@/components/locale-provider";
import { AppearanceControl } from "@/components/nav/appearance-control";
import { cn } from "@/lib/utils";

// The two account-wide preferences that belong within reach of every screen —
// appearance and language — as one labelled block shared by the phone drawer
// and the desktop avatar menu.
//
// They used to sit in a single `justify-between` row: a bare <select> reading
// "System Default" with nothing to say it was a LANGUAGE, a text link, and an
// outlined button, three different control shapes competing for one line. On a
// narrow phone that row overflowed and clipped the sign-out button against the
// edge. Stacking them costs one line of height and fixes both — each control
// now says what it sets, and neither can push the other off the screen.
export function NavPreferences({
  localeToggle,
  className,
}: {
  localeToggle?: ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <section
      aria-label={t("web.nav.preferences")}
      className={cn("flex flex-col gap-4 px-3 py-3", className)}
    >
      <AppearanceControl />
      {localeToggle}
    </section>
  );
}
