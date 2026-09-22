import "server-only";
import { cookies } from "next/headers";
import { READING_COOKIE, decodeReading, type ReadingPreferences } from "@/lib/reading";

/**
 * The request-scoped read, split out because lib/reading.ts has to stay
 * importable from the client control — importing a `server-only` module from a
 * "use client" component fails the build. Same split as lib/i18n.ts against
 * lib/i18n-translate.ts.
 */

/** Read the preference for this request. Never throws: a malformed cookie
 * yields the defaults, because a broken value must not blank the page. */
export async function getReadingPreferences(): Promise<ReadingPreferences> {
  const store = await cookies();
  return decodeReading(store.get(READING_COOKIE)?.value);
}
