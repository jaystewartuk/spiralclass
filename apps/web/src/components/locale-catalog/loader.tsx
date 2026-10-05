"use client";

import dynamic from "next/dynamic";
import type { ComponentType, ReactNode } from "react";
import type { AppLocale } from "@/lib/i18n-translate";

// Each language behind its own `import()`, so each is its own async chunk and
// the page fetches the one it renders. A static import of all three, even
// rendering one, puts all three in the layout's chunk group: the bundler
// groups a layout's client components together and cannot know which one a
// request will render. next/dynamic also preloads the chunk of the one that
// rendered on the server, so hydration does not wait on a second round trip.
//
// Typed over every AppLocale: a registered language without its module here
// fails the typecheck rather than rendering keys.
const CATALOGS: Record<AppLocale, ComponentType<{ children: ReactNode }>> = {
  en: dynamic(() => import("./en")),
  es: dynamic(() => import("./es")),
  fr: dynamic(() => import("./fr")),
};

export function CatalogLoader({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  const Catalog = CATALOGS[locale];
  return <Catalog>{children}</Catalog>;
}
