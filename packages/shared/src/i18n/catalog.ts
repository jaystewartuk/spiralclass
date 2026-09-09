import type { AppLocale } from "./locales";
import { esMX } from "./catalog.es-MX";
import { en } from "./catalog.en";
import { fr } from "./catalog.fr";

// The shared string catalog — the single source of truth for user-facing copy.
// Keys are dot-namespaced; values are per-locale. Interpolate with `{var}`
// placeholders resolved by createT() in ./translate.
//
// `web.*` keys belong to web surfaces migrated off the old inline patterns
// (auth, onboarding, dashboard shell); everything else is the general set,
// hosted here so a future locale is added in one place.
//
// Each locale's actual key-value block lives in its own catalog.<locale>.ts
// file (catalog.es-MX.ts / catalog.en.ts / catalog.fr.ts) — split out of this
// one file once it passed 12k lines across all three locales combined, purely
// for editing/tooling ergonomics (a unique key text alone no longer located a
// single locale block; every edit needed a line-number lookup first). This
// file's only job now is composing them and carrying the completeness guard
// below. Adding a language is still two steps (locales.ts registry row + one
// new catalog.<locale>.ts file, added to the `strings` object below).
export const strings = {
  "es-MX": esMX,
  en,
  fr,
} as const;

// The registry union, re-exported under the name the mobile catalog has always
// used. Equal to AppLocale by construction (the completeness guard below ties
// the two together).
export type Locale = AppLocale;

// A key into the catalog. Derived from the source locale (es-MX); the guard
// below forces every other locale to define the same set.
export type StringKey = keyof (typeof strings)["es-MX"];

// Compile-time COMPLETENESS guarantee. `strings` must structurally satisfy
// "every registered locale → every StringKey". If a key is added to es-MX
// without its `en` translation, or a locale is registered without a catalog
// block, this fails to typecheck. This is the strongest form of "new copy
// can't land untranslated" — enforced by the compiler, not a lint pass.
type AssertExtends<T extends U, U> = T;
type _CatalogIsComplete = AssertExtends<
  typeof strings,
  Record<AppLocale, Record<StringKey, string>>
>;
