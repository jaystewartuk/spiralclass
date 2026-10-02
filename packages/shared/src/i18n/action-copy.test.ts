import { describe, expect, it } from "vitest";
import { strings } from "./catalog";
import { DEFAULT_LOCALE, LOCALES } from "./locales";

/**
 * Server-action messages (`web.action.*`) are translated, not copied.
 *
 * These are the strings that used to be chosen between an English and a
 * Spanish arm at the call site, where every other locale silently read
 * English. Moving them into the catalog makes the compiler demand a value for
 * every locale — and the cheapest way to satisfy the compiler is to paste the
 * English one. This is what stops that: the completeness guard proves a key
 * exists in a locale, never that anyone translated it.
 */
const ACTION = "web.action.";
const actionKeys = Object.keys(strings[DEFAULT_LOCALE]).filter((key) => key.startsWith(ACTION));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("server-action copy", () => {
  it("has keys to check", () => {
    expect(actionKeys.length).toBeGreaterThan(0);
  });

  it("is in each locale's own words, not the default locale's", () => {
    const source = strings[DEFAULT_LOCALE] as Record<string, string>;
    for (const { tag } of LOCALES) {
      if (tag === DEFAULT_LOCALE) continue;
      const table = strings[tag] as Record<string, string>;
      const copied = actionKeys.filter((key) => table[key] === source[key]);
      expect(copied, `${tag} repeats the ${DEFAULT_LOCALE} string for these keys`).toEqual([]);
    }
  });

  it("keeps the same placeholders in every locale", () => {
    const source = strings[DEFAULT_LOCALE] as Record<string, string>;
    for (const { tag } of LOCALES) {
      const table = strings[tag] as Record<string, string>;
      for (const key of actionKeys) {
        expect(placeholders(table[key]!), `${tag} ${key}`).toEqual(placeholders(source[key]!));
      }
    }
  });
});
