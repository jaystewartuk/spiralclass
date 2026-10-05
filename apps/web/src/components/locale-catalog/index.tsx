import type { ReactNode } from "react";
import type { AppLocale } from "@/lib/i18n-translate";
import { CatalogLoader } from "./loader";

/**
 * Gives the tree below it a language: `useLocale()`, and a `useT()` that speaks
 * it.
 *
 * The browser used to receive every language's strings on every page, because
 * the one client provider imported the whole catalog: 1.5 MB of JavaScript,
 * 400 kB gzipped, two thirds of it in languages the reader does not read, and
 * growing with each language added (#178).
 *
 * Each language is now its own module (./en, ./es, ./fr) importing only its own
 * table, loaded by ./loader behind its own `import()`. A French page fetches
 * French. Nothing a Client Component imports may reach the full catalog —
 * `strings`, `createT` — or the split is undone; the build check in
 * apps/web/scripts/catalog-chunks.mjs holds that.
 */
export function LocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return <CatalogLoader locale={locale}>{children}</CatalogLoader>;
}
