// BCP-47 code (e.g. "en", "es") → a human-readable language name in the
// viewer's own locale, via the built-in Intl API — no static lookup table to
// keep in sync. Falls back to the raw code if the runtime can't resolve it.
export function languageDisplayName(
  code: string | null | undefined,
  locale: string,
): string | null {
  const trimmed = code?.trim();
  if (!trimmed) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(trimmed) ?? trimmed;
  } catch {
    return trimmed;
  }
}
