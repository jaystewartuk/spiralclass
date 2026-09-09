// Client-safe i18n surface. Split out from i18n.ts because that module imports
// "next/headers" at the top level (server-only). Client Components that need
// the locale type, the key-based catalog accessor, or the legacy inline-dict
// helper must import from HERE, not from i18n.ts, or the build fails trying to
// bundle next/headers into client code.
//
// All of this now comes from the shared package (@spiralclass/shared), which is
// framework-free — this file is a thin, client-safe re-export so existing
// `@/lib/i18n-translate` imports keep working.
export {
  createT,
  translate,
  type AppLocale,
  type TFunction,
  type StringKey,
} from "@spiralclass/shared";
